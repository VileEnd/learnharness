# Multi-user PR 1: Tenant Context and Per-User Paths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every request runs as a Keycloak user, and all mutable data for that user lives in `data/users/<sub>/`. No user can see another user's chats, graph, documents, jobs, events or activity.

**Architecture:** Each route handler and page is wrapped in an `AsyncLocalStorage` tenant scope, built from the oauth2-proxy identity headers. `config.ts` path values become getters that resolve against that scope, so the store adapters stay unchanged. Process-wide registries are keyed and filtered by tenant. The multi-user layout switches on only with `LH_MULTI_USER=1`, which the image sets. Without it, the dev, test and single-user setups keep today's layout byte for byte, with one implicit `local` admin tenant.

**Tech Stack:** Next.js 16 route handlers, `node:async_hooks` AsyncLocalStorage, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-10-29-multi-user-design.md` (sections 1, 2 and 6, plus the Caddy/oauth2-proxy parts of delivery item 1).

## Global Constraints

- Tenant id: the Keycloak `sub`, taken from `X-Auth-Request-User`. It must match `^[a-z0-9][a-z0-9-]{0,63}$`. Anything else is answered with 401, never sanitised into a different id.
- Admin group name: `learnharness-admin` (`full.path` is false, so the group header carries bare names, comma-separated).
- Multi-user layout: `<LH_DATA_DIR>/users/<id>/` holds exactly today's data layout. `<LH_DATA_DIR>/global/` holds `push/vapid.json` and `prompts/`. `auth.json` stays at `LH_AUTH_FILE`.
- Single-user mode (no `LH_MULTI_USER`) changes nothing on disk. The whole existing test suite must pass without edits to its path expectations.
- Import law: `app/` imports only the `@/src/core` and `@/src/server` barrels. `src/core/tenant-context.ts` is node-only and is NOT exported from `src/core/index.ts`.
- `verbatimModuleSyntax` is on, so use `import type`. Relative imports carry `.ts`.
- Version bump: `0.30.0`, in the same PR (release flow). Main is at 0.29.0.

## Review Focus

1. **A request reaching a route outside a tenant scope.** In multi-user mode, a route that someone forgets to wrap must fail (throw → 500), never write to `<data>/chats`. Owner: Task 1 (getter throws) and Task 5 (a static test that every `app/api/**/route.ts` except `health` uses `withTenant`).
2. **Two users importing the same PDF.** `docId` is the content hash, so it is identical for both users. The extraction, scan and doc-index registries must not coalesce or block across tenants. Owner: Task 3.
3. **A spoofed identity header on public paths.** Caddy's `@pwa` route skips `forward_auth`, so client-sent `X-Auth-Request-*` headers must be stripped before any handler runs. Owner: Task 6 (Caddyfile) and the end-to-end check.
4. **Background continuations losing the tenant.** Work scheduled from inside a request (setTimeout, promise chains, steer wake pumps, doc-index batch timers) must still see the request's tenant. Owner: Task 3 (a test with a `setTimeout` inside `runAsTenant`).
5. **An LLM call outside a tenant scope in multi-user mode.** The request-log sink (`src/agent/request-log.ts`) goes silent after its first failure. A `NoTenantError` there would drop spend lines unseen, and PR 3's caps would undercount. Expected: every such failure is logged, never silenced. Owner: Task 3.
6. **Legacy data on a multi-user boot.** The app must refuse to serve and point at the migration script. It must never silently treat the old `data/chats` as nobody's, or as everybody's. Owner: Task 4.

---

### Task 1: Tenant context and tenant-aware `config.ts`

**Files:**
- Create: `src/core/tenant-context.ts`
- Modify: `config.ts` (PATHS, LEDGER_FILES and the file constants)
- Modify: every importer of the converted constants (`TOPIC_ALIASES_FILE`, `SOURCES_FILE`, `POSITIONS_FILE`, `RENDER_SETTINGS_FILE`, `GRAPH_FORMAT_FILE`, `SETTINGS_FILE`, `PROMPTS_OVERRIDE_DIR`); find them with `grep -rn` across `src app scripts tests`
- Modify: `src/store/jobs.ts:20` (`JOBS_DIR` → function), `src/store/push.ts:17-18` (subscriptions per user, VAPID global)
- Test: `tests/tenancy-paths.test.ts`

**Interfaces:**
- Produces (`src/core/tenant-context.ts`):
  - `interface Tenant { id: string; name: string; isAdmin: boolean }`
  - `const LOCAL_TENANT: Tenant` = `{ id: "local", name: "local", isAdmin: true }`
  - `multiUser(): boolean` returns `process.env.LH_MULTI_USER === "1"`, read at call time so tests can toggle it.
  - `runAsTenant<T>(tenant: Tenant, fn: () => T): T`
  - `currentTenant(): Tenant | undefined` (inside a scope) and `requireTenant(): Tenant`. `requireTenant` returns `LOCAL_TENANT` in single-user mode and throws `NoTenantError` in multi-user mode outside a scope.
  - `tenantKey(id: string): string` returns `` `${requireTenant().id}:${id}` ``.
- Produces (`config.ts`):
  - `DATA_ROOT` (exported)
  - `userDataRoot(): string`: `DATA_ROOT` in single-user mode, otherwise `<DATA_ROOT>/users/<requireTenant().id>`
  - `globalDataRoot(): string`: `DATA_ROOT` in single-user mode, otherwise `<DATA_ROOT>/global`
  - `PATHS.{data,chats,graph,push,documents,drawings,okf,learner,debug,logs}` become getters over `userDataRoot()`. `okf` honours `LH_LIBRARY_DIR` as `path.join(LH_LIBRARY_DIR, id)` in multi-user mode.
  - `PATHS.globalPush` is a getter, `<globalDataRoot()>/push`.
  - `LEDGER_FILES` entries become getters.
  - `topicAliasesFile()`, `sourcesFile()`, `positionsFile()`, `renderSettingsFile()`, `graphFormatFile()` and `settingsFile()` are per user. `promptsOverrideDir()` is global. `AUTH_FILE` is unchanged.

- [ ] **Step 1: Write the failing test** `tests/tenancy-paths.test.ts`. It sets `LH_MULTI_USER=1` and an isolated `LH_DATA_DIR` (mkdtemp) before any dynamic import, then:

```ts
test("settings and chats are per tenant", async () => {
  runAsTenant(A, () => settingsStore.writeSettings({ version: 1, general: {} }));
  assert.ok(fs.existsSync(path.join(dir, "users", "a", "settings.json")));
  assert.equal(runAsTenant(B, () => settingsStore.readSettings()), null);
  const id = runAsTenant(A, () => chatStore.createChat(/* minimal record per the ChatStore port */)).id;
  assert.equal(runAsTenant(B, () => chatStore.getChat(id)), null);
});
test("graph ledgers are per tenant", …appendNodes under A; readNodes under B is []);
test("push subscriptions are per tenant, VAPID is shared", …vapid file at global/push/vapid.json; subscriptions under users/a/push/);
test("multi-user path access outside a tenant throws", () => assert.throws(() => PATHS.chats, /NoTenantError|no tenant/i));
test("single-user mode keeps the legacy layout", …LH_MULTI_USER unset: PATHS.chats === path.join(dir, "chats"));
```

Use the real port method names from `src/core/ports.ts`.

- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/tenancy-paths.test.ts`. Expected: FAIL (the module `src/core/tenant-context.ts` is not found).
- [ ] **Step 3: Implement** `tenant-context.ts` with one AsyncLocalStorage anchored on `globalThis.__lhTenantAls`, following the same HMR and module-instance rule as `turn-liveness.ts`. Then convert `config.ts` and every importer. Inline `path.join(PATHS.x, …)` call sites already read at call time and need no change. Only module-level constants (`jobs.ts:20`, `push.ts:17-18`) become functions.
- [ ] **Step 4: Run** the new test, then `npm test` and `npm run typecheck`. Expected: all pass, with no edits to existing tests beyond renamed imports.
- [ ] **Step 5: Commit** with the message `feat(tenancy): tenant context and per-user data paths`.

### Task 2: Event bus scoped by tenant

**Files:**
- Modify: `src/core/events.ts` (browser-safe, with no node imports)
- Modify: `src/server/events-stream.ts`
- Modify: `app/api/events/route.ts`
- Test: `tests/tenancy-events.test.ts`

**Interfaces:**
- Consumes: `currentTenant`, `multiUser` (Task 1)
- Produces: `setEventScope(scope: () => string | undefined): void` in `core/events.ts`. `emit` stamps `tenant: scope()` on each event, and `ServerEvent` gains an optional `tenant?: string`. Also `eventsResponse(tenantId: string | undefined): Response`, which drops events whose `tenant !== tenantId` when `tenantId` is defined, and never serialises `tenant`. The scope is registered once in `src/server/tenant.ts` (Task 5); for this task, register it in `events-stream.ts` at module load, and Task 5 moves it.

- [ ] **Step 1: Write the failing test.** Read the `eventsResponse("b")` stream body, `emit("chats-changed", {})` under tenant a and then under b, and assert exactly one `event: chats-changed` frame with no `tenant` key in its data.
- [ ] **Step 2: Run it.** Expected: FAIL (two frames).
- [ ] **Step 3: Implement** the change in `events.ts` and `events-stream.ts`. The route passes `requireTenant().id` in multi-user mode and `undefined` otherwise.
- [ ] **Step 4: Run** the test and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(tenancy): scope server events to the tenant`.

### Task 3: Per-tenant singletons and registries

**Files:**
- Create: `src/server/tenant-singleton.ts`
- Modify:
  - `src/server/doc-index.ts:1136`
  - `src/server/okf-library.ts:20` (in multi-user mode, warm-up moves to first use)
  - `src/server/jobs.ts` (`recoverStaleJobs` throttle per tenant)
  - `src/agent/subagents/extraction.ts` (`runs()` registry: key `running`/`inFlight` by `tenantKey`, each entry records `tenant`, and `extractionStatuses()` and `abortExtraction()` see only the current tenant's entries)
  - `src/server/documents.ts:153` (scans) and `src/server/doc-index.ts:303` (scanRows), with the same keying and filtering
  - `src/server/stores.ts:55-73` (the boot usage backfill): skip it when `multiUser()`. `ensureBackfill()` in `src/server/usage.ts` already runs it per tenant on that tenant's first `/api/usage` read.
  - `src/agent/request-log.ts` `recordRequest`: a `NoTenantError` from the sink is always `console.error`ed and never counts toward the once-only silence
- Test: `tests/tenancy-registries.test.ts`

**Interfaces:**
- Consumes: `requireTenant`, `tenantKey` (Task 1)
- Produces: `tenantSingleton<T extends object>(globalKey: string, make: () => T): T`, a Proxy that forwards every property access to a per-tenant-id instance held in a `globalThis[globalKey]` Map and binds functions to that instance. `docIndex` and `library` keep their exported names and types.

- [ ] **Step 1: Write the failing tests:**
  - `tenantSingleton` gives the same instance for the same tenant and different instances for a and b, and `make` is called once per tenant.
  - Inside `runAsTenant(A, () => setTimeout(cb, 0))`, `cb` sees `currentTenant()?.id === "a"`.
  - Start a faux extraction run under tenant a with the harness used by the existing extraction tests (`tests/extraction*.test.ts`). `extractionStatuses()` under b is `[]` and under a has length 1. Starting the same source id under b is not refused as in-flight.
  - With `LH_MULTI_USER=1` and a sink installed through `setRequestSink((l) => requestLogStore.append(l))`: `recordRequest` under tenant a writes to `users/a/logs/`. Outside a scope, two calls each produce a `console.error` (stub it and count the calls).
  - `recoverStaleJobs()` under b does not consume a's throttle window (call it under a, then under b, and assert b's sweep ran by spying on `chatStore.listChats` through the store module).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `tenantSingleton` and wire it in. Convert the registries listed above.
  - Registries keyed by random chat or job ids (turn-liveness, turn-runs, aborts, compaction, dismissal-park, wake) stay process-global. Their routes load the record from the tenant's store first, so a foreign id is a 404 before any registry is touched. Verify each route does that, and add the lookup where it is missing.
  - The audit lock, the LLM semaphore and the topic alias lock stay global; they serialise but do not leak.
- [ ] **Step 4: Run** the tests, `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(tenancy): per-tenant indexes, library and run registries`.

### Task 4: Legacy-layout guard, migration script, health route

**Files:**
- Create: `scripts/migrate-to-tenants.ts`
- Create: `app/api/health/route.ts`
- Modify: `config.ts` (legacy detection)
- Modify: `Dockerfile` (HEALTHCHECK → `/api/health`; `ENV LH_MULTI_USER=1`)
- Test: `tests/tenancy-migration.test.ts`

**Interfaces:**
- Produces:
  - `legacyLayoutPresent(): boolean` in `config.ts`. It is true when `multiUser()` and any of `chats/`, `graph/`, `documents/` or `settings.json` exists directly under `DATA_ROOT`.
  - `userDataRoot()` throws `LegacyLayoutError` (message names `scripts/migrate-to-tenants.ts`) while the legacy layout is present.
  - `GET /api/health` → `200 {ok:true}`. On a legacy layout it returns `503 {error:"legacy_layout", fix:"node --experimental-strip-types scripts/migrate-to-tenants.ts --owner <keycloak-sub>"}`. The health route is NOT tenant-wrapped.
  - CLI: `migrate-to-tenants.ts --owner <sub>` (owner validated against the tenant-id regex).
    - It moves every top-level entry of `DATA_ROOT` except `users` and `global` into `users/<owner>/`, then moves `users/<owner>/push/vapid.json` → `global/push/vapid.json` and `users/<owner>/prompts` → `global/prompts`.
    - It exits non-zero without changes if `users/` already exists.
    - It uses `fs.renameSync` only (same filesystem) and copies nothing.

- [ ] **Step 1: Write the failing tests:**
  - Copy `tests/fixtures/golden-data/` into a temp dir and run the script with `--owner a` through `execFileSync(process.execPath, ["--import", "tsx", script, "--owner", "a"], { env: { LH_DATA_DIR } })`. Assert that a recursive listing of `users/a/` equals the fixture's listing and that a second run exits 1.
  - Under `LH_MULTI_USER=1` with a legacy dir, the health GET returns 503 and `PATHS.chats` inside `runAsTenant(A)` throws `LegacyLayoutError`.
  - A malformed owner (`"Foo@x"`) exits 1.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the script, the guard and the route. Mirror the arg parsing and logging style of `scripts/migrate-subscription-routes.ts`. Make the exact invocation in the 503 `fix` text match how the image can run it; check which of `node --import tsx`, `npx tsx` or a compiled script exists in the standalone image and use that.
- [ ] **Step 4: Run** the tests and `npm test`. Expected: PASS. `tests/golden-fixtures.test.ts` must pass unchanged.
- [ ] **Step 5: Commit** with the message `feat(tenancy): legacy-layout guard, migration script, health route`.

### Task 5: Identity resolution and wrapping every route and page

**Files:**
- Create: `src/server/tenant.ts` (exported from `src/server/index.ts`)
- Modify: all 51 `app/api/**/route.ts` handlers, plus the pages `app/page.tsx`, `app/documents/page.tsx`, `app/documents/[id]/page.tsx`, `app/chat/[id]/page.tsx` and `app/chat/new/page.tsx`
- Test: `tests/tenancy-identity.test.ts`

**Interfaces:**
- Consumes: Task 1 (context), Task 2 (`setEventScope`, registered here)
- Produces:
  - `resolveTenant(headers: Headers): Tenant | null`
    - In single-user mode it returns `LOCAL_TENANT`.
    - In multi-user mode it needs `x-auth-request-user` matching the id regex, otherwise it returns null.
    - `name` is `x-auth-request-preferred-username` if present, then `x-auth-request-email`, then the id.
    - `isAdmin` is true when `x-auth-request-groups` (comma-split, trimmed, a leading `/` stripped) contains `process.env.LH_ADMIN_GROUP ?? "learnharness-admin"`.
  - `withTenant<A extends unknown[]>(handler: (req: Request, ...rest: A) => Response | Promise<Response>): (req: Request, ...rest: A) => Promise<Response>`. When `resolveTenant` returns null it answers `401 {error:"unauthenticated"}`.
  - `withPageTenant<T>(fn: () => T | Promise<T>): Promise<T>`, which reads `await headers()` from `next/headers`. Read `node_modules/next/dist/docs/` for the Next 16 `headers()` API before writing it. When there is no tenant it calls `unauthorized()` or throws, per those docs.

- [ ] **Step 1: Write the failing tests:**
  - The `resolveTenant` cases: missing header → null; email-shaped user → null; a UUID → tenant; groups `"learnharness,learnharness-admin"` → isAdmin; `"/learnharness-admin"` → isAdmin; single-user mode → `LOCAL_TENANT`.
  - `withTenant` returns 401 without the header in multi-user mode.
  - Write settings through `PUT /api/settings/[section]` as user a, then call `GET /api/settings` (the real route module, dynamically imported) with user a's headers and with user b's. Assert that a gets the record and b gets `{settings:null}`.
  - A static test: every `app/api/**/route.ts` except `app/api/health/route.ts` contains `withTenant(` on every exported HTTP method. Read the files and use a regex over `export const (GET|POST|PUT|PATCH|DELETE)`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `tenant.ts` and convert every route. The pattern is `export const GET = withTenant(async (req) => { … })`, which replaces `export async function GET(req)`. Keep `export const dynamic` and the other route config exports. Pages wrap the body of the default export in `withPageTenant`, and every server read must stay inside the callback. Move the `setEventScope` registration here.
- [ ] **Step 4: Run** the tests, then `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. Expected: all clean.
- [ ] **Step 5: Commit** with the message `feat(tenancy): resolve the Keycloak user per request and scope every route`.

### Task 6: Deploy wiring, docs, version

**Files:**
- Modify: `deploy/caddy/Caddyfile`
  - Add `request_header -X-Auth-Request-*` as the first directive in the `{$LH_HOST}` block.
  - Change both `copy_headers` to `X-Auth-Request-User X-Auth-Request-Email X-Auth-Request-Preferred-Username X-Auth-Request-Groups`.
- Modify: `deploy/compose.yaml`: add `OAUTH2_PROXY_USER_ID_CLAIM: sub` to oauth2-proxy and `LH_MULTI_USER: "1"` to learnharness.
- Modify: `deploy/keycloak/realm-learnharness.json`: add the group `{ "name": "learnharness-admin", "path": "/learnharness-admin" }`.
- Modify: `docs/architecture.md`: add a "Tenancy" section (scope, layout, keyed registries, single-user mode), and replace the stale PracticeStore/practice.ts line.
- Modify: `docs/self-hosting.md`: replace "One shared data set" with the per-user model, and add the upgrade runbook (create the `learnharness-admin` group and join it; find your `sub` in Keycloak; stop the stack; run the migration; start; existing sessions log out and back in once because the user claim changed).
- Modify: `CLAUDE.md`: add a tenancy line under Key runtime mechanisms.
- Modify: `package.json` and `package-lock.json`: set the version to `0.30.0` with `npm version 0.30.0 --no-git-tag-version`.
- Test: the end-to-end check in Step 2.

- [ ] **Step 1: Make the edits.** Run `docker compose -f deploy/compose.yaml config -q` with a dummy `.env` copied from `.env.example`. Expected: exit 0.
- [ ] **Step 2: Docker end-to-end** (Docker Desktop through `/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe`):
  - Build the image.
  - Run it with `LH_MULTI_USER=1` and a fresh volume, then check:
    - `/api/health` → 200.
    - `curl` `/api/settings` without headers → 401.
    - With header user a, PUT then GET returns a's settings; user b gets null.
  - Place a legacy `chats/` dir in the volume → health 503. Run the migration inside the container → health 200.
  - Run Caddy locally if feasible and check that a spoofed `X-Auth-Request-User` to `/manifest.webmanifest` never reaches the app (log the header in a scratch build, or rely on the Caddy `request_header` unit and say so).
- [ ] **Step 3: Gates:** `npm run typecheck && npm test && npm run lint && npm run build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs`. Expected: all clean.
- [ ] **Step 4: Commit** with the message `feat(tenancy): deploy wiring, docs, 0.30.0`.
