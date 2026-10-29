# Per-user Models and Monthly Caps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin decides which models each user gets and caps each user's monthly spend. Restricted users can only use those models, and they are blocked with a clear message once the month's spend reaches the cap.

**Architecture:**
- A global `admin.json` holds the policy.
- One gate, injected into `piEngineForSpec`, enforces the cap and the model list on every LLM call. The cost comes from the user's existing request log.
- The settings read path overlays the policy slots for restricted users.
- The admin edits everything in the existing Settings → Users section.

**Tech Stack:** Next.js 16, TypeScript, node:test, renderToStaticMarkup.

**Spec:** `docs/superpowers/specs/2026-10-29-multi-user-design.md` §10 (also §3–§5).

## Global Constraints
- **Policy file:** `<globalDataRoot()>/admin.json`, written with temp-then-rename at mode 0600.
- **Shape:** `{version:1, newUserDefaults: UserPolicy, users: {[userId]: UserPolicy}}`, where `UserPolicy = {slots: {strong?, cheap?, vision?: {provider, id}}, allowedModels: string[] /* "provider:id" */, monthlyCapUsd: number | null}`.
- **Built-in defaults when the file is absent:**
  - strong and cheap: the first available `badge:"Cheapest"` entry of `RECOMMENDED_MODELS`.
  - vision: the first available `Cheapest` entry whose catalog model accepts image input, or unset.
  - allowedModels: all available `Cheapest` entries.
  - monthlyCapUsd: `5`.
  - "Available" means present in the live catalog (`recommendedFor`).
- **Restricted** means multi-user mode AND a non-admin tenant. Admins and single-user mode are never gated.
- **Allowed set** = `allowedModels ∪ {slot models}`, compared as `` `${provider}:${id}` ``.
- **Errors:**
  - `MonthlyCapReachedError` → HTTP `403 {error, code:"monthly_cap_reached", capUsd, spentUsd}`.
  - `ModelNotAllowedError` → `403 {error, code:"model_not_allowed", model}`.
  - The chat copy:
    - "You've reached this month's spending limit ($<cap>). Ask your admin to raise it."
    - "That model isn't available for your account."
- **Absent stays absent:** unpriced calls count as 0 toward the cap but are never shown as $0. The admin view shows the unpriced count.
- **Import law:**
  - `app/` imports only the barrels; `components/` imports only `@/src/core`.
  - `src/agent` never imports server or store. The gate is injected like `setRequestSink`.
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails in code or tests.
- **Version:** `0.33.0`.

## Review Focus
1. **Every LLM path.** Turns, background roles, extraction, attribution, describe/transcribe and embeddings all reach the gate. Embeddings and OCR are `fetch` seams, not engines, so they are NOT gated by model; they are gated by cap via a `assertWithinCap()` call in their entry points. Owner: Task 2.
2. **Cap reached mid-turn.** A multi-step turn crosses the cap. Calls after the crossing throw, the turn ends with the cap message, and the persisted transcript stays valid. Owner: Task 2 test.
3. **Admin edits a restricted user's policy** while that user holds a chat pinned to a now-disallowed model. The next turn substitutes the strong slot instead of failing. Owner: Task 2 test.
4. **Missing catalog entries.** A recommended model is not in the catalog (provider key missing). The defaults skip it; with no candidate at all, the slot is unset. Owner: Task 1 test.
5. **Spend fold cost.** The cap check runs on every call, so it must not re-read the month file each time. The cache key is the month file's size and mtime. Owner: Task 2 test (two checks, one read).

---

### Task 1: Policy contract, store and resolution

**Files:**
- Create: `src/core/contracts/admin.ts` (types, `modelKey(m)`, `allowedSet(policy)`; browser-safe)
- Modify: `src/core/ports.ts` (`AdminPolicyStore { readPolicy(): AdminPolicy | null; writePolicy(p: AdminPolicy): void }`)
- Create: `src/store/admin-policy.ts`, wired in `src/server/stores.ts`
- Create: `src/server/policy.ts`
- Test: `tests/policy.test.ts`

**Produces (server):**
- `builtInDefaults(catalogModels: Array<{provider, id, input?: string[]}>): UserPolicy`
- `currentPolicy(): AdminPolicy` — the file, or `{version:1, newUserDefaults: builtInDefaults(...), users:{}}`
- `policyFor(userId: string): UserPolicy` — the user's entry, otherwise `newUserDefaults`
- `restrictedPolicy(): UserPolicy | null` — the ambient tenant's policy when restricted, else null
- `setUserPolicy(userId, p | null)` — `null` removes the entry, so the user falls back to defaults
- `setDefaults(p)`
- `validatePolicy(raw): {ok:true, policy} | {ok:false, error}`
  - every model must exist in the catalog;
  - the cap is `null` or a finite number ≥ 0;
  - `allowedModels` is deduplicated.

- [ ] **Step 1: Failing tests.**
  - (a) Built-in defaults pick the first `Cheapest` entry present in a stub catalog for strong and cheap, and skip absent ones.
  - (b) Vision is the first `Cheapest` entry with `"image"` input; with none, vision is unset.
  - (c) The cap defaults to 5.
  - (d) `policyFor` falls back to defaults, and a user entry wins.
  - (e) `restrictedPolicy()` is null for admins and in single-user mode, and returns the policy for a non-admin tenant in multi-user mode.
  - (f) `admin.json` is written at 0600 and round-trips.
  - (g) `validatePolicy` rejects an unknown model and a negative cap.
- [ ] **Step 2:** Run `NODE_ENV=test npx tsx --test tests/policy.test.ts` and confirm it FAILS.
- [ ] **Step 3:** Implement. **Step 4:** The test, `npm test` and `typecheck` all PASS.
- [ ] **Step 5:** Commit `feat(policy): per-user model and cap policy (admin.json)`.

### Task 2: Enforcement — the gate, settings overlay, catalog filter, chat refusal

**Files:**
- Modify: `src/agent/models.ts`
  - Add `setModelGate(gate: ((spec, opts) => ResolvedModelSpec) | null)`.
  - `piEngineForSpec` calls the gate first.
  - The gate receives `opts.purpose`, so it can map a `ModelRole` to its tier through `ROLE_SLOT`. Conversation purposes map to strong.
- Modify: `src/core/settings.ts` — add `MonthlyCapReachedError` and `ModelNotAllowedError`, with envelopes, in the style of `ModelsNotConfiguredError`.
- Create: `src/server/model-gate.ts`, installed in `src/server/stores.ts` next to `setRequestSink`.
  - `spentThisMonth(): {usd: number; unpriced: number}`: `usageMonth()` cached per tenant on the current month file's size and mtime.
  - `assertWithinCap()`: throws `MonthlyCapReachedError` for restricted users at or over their cap.
  - `gate(spec, opts)`: runs `assertWithinCap()`, then the allowed check, then substitution or `ModelNotAllowedError`.
- Modify:
  - `src/server/chat-handler.ts`: call `assertWithinCap()` before the write-ahead persist, and map both errors to their 403 envelopes.
  - `src/server/turn-service.ts`, `src/server/attribution.ts`, `src/server/documents.ts`: catch the new errors where they catch `ModelsNotConfiguredError`, as contained failures.
  - The embedding and OCR entry points (`src/server/doc-index.ts` live embedder and `src/server/ocr-client.ts`): call `assertWithinCap()`; an over-cap user skips quietly.
- Modify:
  - Settings read: wherever `readSettings`/`readSettingsRecord` feed resolution (the server barrel export and `settingsStore.readSettings`). For restricted users, overlay `models.{strong,cheap,vision}` with the policy slot when the user's slot is missing or disallowed.
  - Writes in `src/server/settings-body.ts` (models section, agent role overrides) and the per-chat settings route reject disallowed models with 403 `model_not_allowed`.
- Modify: `src/server/model-catalog.ts` `modelCatalog()` — for restricted users, return only models in the allowed set.
- Modify: `components/chat.tsx` — render `monthly_cap_reached` and `model_not_allowed` with the copy from Global Constraints, in the same place other turn refusals render. Do NOT trigger the setup flow.
- Test: `tests/model-gate.test.ts` (faux engines, multi-user headers, as in `tests/admin-users.test.ts`)

- [ ] **Step 1: Failing tests.**
  - (a) A restricted user under the cap with an allowed model builds the engine unchanged.
  - (b) A disallowed chat model substitutes the strong slot. A disallowed `extractor` override substitutes the cheap slot.
  - (c) A disallowed model with its tier slot unset throws `ModelNotAllowedError`.
  - (d) With the request log showing a $5.10 spend and a $5 cap, `POST /api/chat` returns 403 `monthly_cap_reached` with `capUsd` 5, and the chat file is unchanged (no persisted user turn).
  - (e) An admin with the same log is not blocked.
  - (f) Two `assertWithinCap()` calls read the month file once (spy on `requestLog.readMonth`).
  - (g) `PUT` models with a disallowed model returns 403 `model_not_allowed`. An allowed one returns 200.
  - (h) `/api/models` for a restricted user lists only allowed models, while an admin gets the full catalog.
  - (i) For a restricted user with no `settings.json`, reading settings yields the policy slots, so `slotsConfigured` is true.
  - (j) Render: the chat refusal copy for both codes.
- [ ] **Step 2:** Confirm the tests FAIL. **Step 3:** Implement. **Step 4:** `npm test`, `typecheck`, `lint` and `build` all PASS.
- [ ] **Step 5:** Commit `feat(policy): enforce per-user models and monthly caps`.

### Task 3: Admin policy and usage API

**Files:**
- Create: `app/api/admin/policy/route.ts`
  - `GET` returns `{defaults: UserPolicy, users: {[id]: UserPolicy}}`.
  - `PUT /defaults` is done as `app/api/admin/policy/defaults/route.ts`, taking a `UserPolicy`.
- Create: `app/api/admin/users/[id]/policy/route.ts` — `PUT` takes `UserPolicy | {useDefaults:true}` and returns 204.
- Create: `app/api/admin/usage/route.ts` — `GET` returns `{month, users: [{userId, spentUsd, unpricedCalls, capUsd: number|null, restricted: boolean}]}`. It runs `usageMonth()` under `runAsTenant` for every directory in `<data>/users/` whose name matches `TENANT_ID_RE`. `restricted` is false for Keycloak admins, which needs an `isAdmin` lookup via `keycloakAdmin()` and is `true` if unknown.
- Every route uses `withTenant`, then `requireAdmin()`, then validation through `validatePolicy` (400 `invalid_policy`, plus a detail).
- Update the route count in `tests/tenancy-identity.test.ts`.
- Test: `tests/admin-policy.test.ts`
  - non-admin → 403;
  - defaults round-trip;
  - user policy set, then reset to defaults;
  - an invalid model gives 400;
  - usage folds two tenants' logs separately.
- [ ] Steps: failing tests, then RED, then implement, then GREEN (the test, `npm test`, `typecheck`, `lint`), then commit `feat(admin): policy and per-user usage API`.

### Task 4: Admin UI — defaults box, per-user models and limit, spend

**Files:**
- Modify: `components/settings/users-section.tsx`. Keep the pure `UsersSectionView` and add props.
- Test: `tests/render-users-section.test.tsx` (extend)

**Behaviour:**
- **"New user defaults" box** at the top: three slot pickers (strong, cheap, vision), a multi-select "Also allowed", and "Monthly limit ($)" (empty means no limit), with a Save button.
  - The pickers reuse the existing model picker or menu from `components/settings/model-menu.tsx` where possible. Read it first.
  - A "Recommended" hint marks the `Cheapest` picks.
- **Per user row:**
  - Spend: "$x.xx this month" plus " of $cap", or "no limit". Add "(+n unpriced calls)" when n > 0.
  - Admins show "admin — unrestricted" instead of an editor.
  - Non-admins get an expandable "Models & limit" editor (the same editor as the defaults) with a "Use defaults" toggle.
  - Show a red "limit reached" badge when spent ≥ cap.
- **Data:** the stateful wrapper fetches `/api/admin/policy`, `/api/admin/usage` and `/api/models` (for the picker options).
- **Errors:** `invalid_policy` shows "Couldn't save: <detail>".

- [ ] **Step 1: Failing render tests.**
  - The defaults box renders the slot values and the cap.
  - A user over their cap shows "limit reached".
  - An admin row shows "unrestricted" and no editor.
  - Unpriced calls show.
  - "Use defaults" checked hides the per-user fields.
- [ ] Steps: RED, implement, then GREEN (`npm test`, `typecheck`, `lint`, `build`), then bump the version to 0.33.0 and run the full gate line, then commit `feat(admin): models and spending limits in Settings → Users`.

### Task 5: Deploy and verify (controller)
1. Merge, then `systemctl restart learnharness-stack` (app-only change; no `nixos-rebuild`).
2. As admin, open Settings → Users and check the defaults show MiMo Flash and $5.
3. Create a test user and log in as them in a private window. They can chat with no setup prompt, and the model picker shows only the allowed models.
4. Set the test user's cap to $0.01, send one message, then send another and check that the second shows the limit message.
5. Remove the test user's devices if any. Disable or delete the test user in Keycloak (the app has no delete yet).
6. Tag v0.33.0 and publish the release.
