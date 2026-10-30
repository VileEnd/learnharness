# Claude Code (Admin-Only Experiment): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin can chat on `claude-code:opus|sonnet|haiku`. These models run on the Claude Code CLI in a separate, locked-down `claude` container, using the admin's own login. No other user and no background work can ever use them.

**Architecture:**
- Port upstream's Claude Code engine (amosblomqvist/learnharness `dc4c398`, `src/agent/claude-code/*`). Swap its local `spawn` for a **runner client**. The client talks a small full-duplex TCP protocol to `deploy/claude/runner.mjs` in the `claude` container, and the runner builds the CLI argument list itself.
- The per-process MCP tool bridge stays in the app. It binds the app's address on a private compose network, so the CLI calls the app's tools back across it.
- An admin toggle (off by default) and a hard gate rule keep the models to admin chat turns.

**Tech Stack:** Next.js 16, TypeScript, pi-ai/pi-agent-core, `@modelcontextprotocol/sdk` 1.32.1 (new; published 2026-10-05), `@anthropic-ai/claude-code` 2.1.301 (in the runner image only; published 2026-10-15), Docker Compose, NixOS, node:test.

**Spec:** `docs/superpowers/specs/2026-10-30-claude-code-admin-design.md`. Upstream source is read with `git -C <upstream checkout> show dc4c398:<path>`; the `upstream` remote is already fetched there.

## Global Constraints
- **Never available to non-admins.** In multi-user mode the gate refuses `claude-code:*` unless `requireTenant().isAdmin`, whatever an allow-list or saved setting says. Single-user mode counts as admin (`LOCAL_TENANT.isAdmin`).
- **Chat turns only.** The gate admits a `claude-code` spec only when all of these hold:
  - `opts.chatId` is set;
  - `opts.role` is undefined;
  - `opts.purpose ∈ {"teacher", "prober", "practice"}` (the turn engine at `src/server/chat-handler.ts:419`).

  Everything else is refused: compaction, `resolveEngine` role engines, jobs, extraction, embeddings and OCR.
- **Off by default.** The admin policy file (`data/global/admin.json`, `AdminPolicy`) gets an optional `claudeCode?: { enabled: boolean }`, and absent means off. The gate reads it fresh on every call. No schema version bump: the field is optional and older builds ignore it.
- **Unpriced, never $0.**
  - `createPricer` returns `null` for provider `claude-code`.
  - `toModelDto` gives `cost: null`.
  - Requests are never stamped `providerCostUsd`.
  - The CLI's `total_cost_usd` is ignored.
- **The runner never takes caller flags.** `toClaudeArgs` lives only in `deploy/claude/runner.mjs`. The fixed flag set is upstream's `toClaudeArgs` (`dc4c398:src/agent/claude-code/stream.ts:84-114`) verbatim.
- **Minimum CLI version** `2.1.259` (upstream `CLAUDE_CODE_MINIMUM_VERSION`). The image pins `@anthropic-ai/claude-code@2.1.301` with `DISABLE_AUTOUPDATER=1`.
- **The `claude` container has:**
  - no `/data` mount;
  - no app secrets;
  - env limited to `CLAUDE_RUNNER_TOKEN`, `CLAUDE_RUNNER_LISTEN`, `LH_APP_HOST`, `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER` and `HOME`;
  - a non-root user, `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` and `tmpfs: /tmp`;
  - one volume, `./volumes/claude:/claude`.

  Caddy publishes nothing new.
- **Compose addresses** (private network `claude-bridge`, `internal: true`, subnet `172.30.66.0/29`):
  - app `172.30.66.2`;
  - claude `172.30.66.3`;
  - runner port `8790`.

  The claude container also joins `claude-egress`, a normal bridge, for api.anthropic.com.
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails. The compose IPs above are private placeholders and fine.
- **Version:** `0.40.0`.

## Runner Protocol (pinned; Tasks 1 and 2 must match)
- **Transport:** plain TCP. Each frame is one UTF-8 JSON object per `\n`-terminated line. The maximum frame is **32 MiB**; a longer frame closes the connection with an `invalid` error.
- **First frame, client → runner:**
  - `{"token": string, "op": "status"}`, or
  - `{"token": string, "op": "run", "run": ClaudeRunRequest}`.
  - The token is compared with `timingSafeEqual`. A wrong token gets `{"error":"unauthorized"}` and the connection closes.
- **`ClaudeRunRequest`:**
  - `model`: one of `"opus"|"sonnet"|"haiku"`;
  - `effort`: one of `"low"|"medium"|"high"|"xhigh"|"max"`;
  - `systemPrompt`: a string;
  - `mcp`: `{ url: string, authorization: string }`. The url must parse as `http://${LH_APP_HOST}:<port>/mcp`, and authorization must match `^Bearer [0-9a-f]{64}$`;
  - `allowedTools`: a `string[]` of at most 64 entries, each matching `^mcp__learnharness__[A-Za-z0-9_-]{1,64}$`;
  - unknown keys are refused.
- **Status reply:** `{"status": {"state": "meets-minimum"|"update-required"|"version-unchecked"|"not-found", "version": string|null, "minimumVersion": "2.1.259"}}`, then the runner closes the connection.
- **Run replies, runner → client:**
  - `{"started": true}` once the process has spawned;
  - `{"stdout": line}` for each stdout line;
  - `{"stderr": chunk}`;
  - finally `{"exit": number|null, "signal": string|null}`, then the runner closes the connection.
  - Refusals are `{"error": "invalid"|"busy"|"update_required"|"spawn_failed", "message": string}`, then close.
- **Run frames, client → runner:**
  - `{"stdin": line}` writes `line + "\n"`;
  - `{"endStdin": true}`;
  - `{"signal": "SIGTERM"|"SIGKILL"}`.
- **The client drops the connection:** the runner sends SIGTERM, then SIGKILL after 1000 ms.
- **Concurrency:** at most `2` running processes. A third run gets `busy`.
- **Spawn:** `${CLAUDE_BIN ?? "claude"} ...toClaudeArgs(...)`.
  - The cwd is a fresh `mkdtemp` directory under `/tmp`.
  - The system prompt and the MCP config `{"mcpServers":{"learnharness":{"type":"http","url":…,"headers":{"Authorization":…}}}}` are written there at mode `0600`.
  - The env is `{ PATH, HOME, CLAUDE_CONFIG_DIR, DISABLE_AUTOUPDATER: "1", MCP_TOOL_TIMEOUT: "1800000" }`.
  - The directory is removed on exit.

## Review Focus
1. **The admin is later demoted.** Their old chat is still pinned to `claude-code:sonnet`, so their next turn must be a 403 `model_not_allowed` with nothing persisted, not a silent run. Owner: Task 3.
2. **The admin turns the toggle off while a question tool is held.** The answer turn is refused with readable text, and the CLI process idles out; nothing crashes. Owner: Task 3.
3. **The CLI isn't logged in, or the runner is unreachable.** The turn fails with readable copy naming the fix, and Retry and the model switch still work. Owner: Task 2.
4. **The app restarts or the turn is aborted mid-stream.** The runner kills the CLI with no orphan process. Owner: Task 1.
5. **An image message makes a multi-MB stdin frame.** It passes a 5 MB line intact. Owner: Task 1.

---

### Task 1: The runner and its container
**Files:**
- Create:
  - `deploy/claude/runner.mjs`: dependency-free ESM. It exports `toClaudeArgs`, `validateRun`, `compareVersion` and `createRunner`, and starts the runner when run directly.
  - `deploy/claude/Dockerfile`.
  - `tests/claude-runner.test.ts`.
  - `tests/fixtures/claude-code/fake-claude.mjs`, `signed-out.jsonl`, `text.jsonl` and `tool.jsonl`, copied from `dc4c398`.
- Modify:
  - `deploy/compose.yaml`: the `claude` service, the `claude-bridge` and `claude-egress` networks, and `learnharness` on `claude-bridge` at `172.30.66.2` with env `CLAUDE_RUNNER_ADDR: 172.30.66.3:8790`, `CLAUDE_RUNNER_TOKEN`, `CLAUDE_BRIDGE_HOST: 172.30.66.2`.
  - `deploy/.env.example`.
  - `deploy/nixos/learnharness-stack.nix`: generate `CLAUDE_RUNNER_TOKEN=$(openssl rand -hex 32)` for new installs, plus the "add once" grep line used for `KC_ADMIN_API_SECRET`. Create `${stateDir}/src/deploy/volumes/claude`, owned by uid 1000 with mode 0700, or wherever the compose project's volumes live, following the existing volume handling.
  - `docs/self-hosting.md`: a "Claude Code (admin, experimental)" section covering the toggle, the one-time login `ssh -t root@<vm-host> docker exec -it learnharness-claude-1 claude` followed by `/login`, that the login lives in `deploy/volumes/claude` and must never be backed up, and the Consumer Terms caveat in one sentence.

**Interfaces:**
- Produces:
  - `createRunner({ claudeBin, token, appHost, maxConcurrent = 2, killGraceMs = 1000 }): net.Server`.
  - `toClaudeArgs({ model, effort, systemPromptFile, mcpConfigFile, allowedTools }): string[]`.
  - `validateRun(body: unknown, appHost: string): { ok: true, run } | { ok: false, message }`.
  - `compareVersion(a, b): -1|0|1`.
  - Tests in Task 2 import `toClaudeArgs` from `../deploy/claude/runner.mjs`.

- [ ] **Step 1: Write the failing tests** in `tests/claude-runner.test.ts`. Start `createRunner` on port 0 with `claudeBin` set to a tiny wrapper script that runs `fake-claude.mjs` under `process.execPath`, and drive it with `node:net`:
  - `rejects a wrong token`: the reply is `{"error":"unauthorized"}`, then close.
  - `refuses an MCP url on another host`: `http://10.0.0.9:1/mcp` gets an `invalid` error, and so does an `allowedTools` entry `"Bash"`.
  - `refuses unknown keys`: a `run` with an extra `"args"` key gets an `invalid` error.
  - `streams a text turn`: the `text.jsonl` scenario gives `started`, then `stdout` lines, then `exit` with code 0.
  - `kills the CLI when the client disconnects`: a scenario that hangs. Destroy the socket and assert the fake's pid is gone within 1500 ms, checked with `process.kill(pid, 0)` throwing `ESRCH`. The fake reports its pid on stderr.
  - `third concurrent run is busy`.
  - `passes a 5 MB stdin line intact`: the fake echoes stdin lengths on stderr.
  - `toClaudeArgs matches upstream`: compare against the exact array from `dc4c398` for one input, including `"--tools", ""`, `"--permission-prompts", "none"` and `"--no-session-persistence"`.
  - `compareVersion("2.1.258","2.1.259") === -1`.
- [ ] **Step 2:** Run `NODE_ENV=test npx tsx --test tests/claude-runner.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `runner.mjs` to the pinned protocol.
  - Status runs `claude --version` once at startup and caches the result.
  - A `run` refuses `update_required` unless the state is `meets-minimum`.
- [ ] **Step 4:** Write the Dockerfile:
  - base `node:26-slim`;
  - `npm i -g @anthropic-ai/claude-code@2.1.301`;
  - `ENV DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=/claude HOME=/home/node`;
  - `USER node`;
  - `CMD ["node","/app/runner.mjs"]`.

  Add the compose service with the Global Constraints hardening, `mem_limit: 2g` and `restart: unless-stopped`.
- [ ] **Step 5: Verify.**
  - The tests pass.
  - `docker compose -f deploy/compose.yaml config -q` succeeds, using a throwaway `.env` copied from `.env.example`.
  - `docker build -f deploy/claude/Dockerfile deploy/claude` succeeds.
  - `nix build ./deploy/nixos#nixosConfigurations.learnharness.config.system.build.toplevel` succeeds.
- [ ] **Step 6: Commit** `feat(claude-code): locked-down runner container`.

### Task 2: The engine port over the runner
**Files:**
- Create, ported from `dc4c398` (adapt imports, keep behaviour):
  - `src/agent/claude-code/cli-events.ts`, `context-window.ts`, `live-processes.ts`, `reuse-context.ts`, `transcript.ts`, `tool-bridge.ts`, `stream.ts`, `provider.ts`, `constants.ts`;
  - `src/core/contracts/claude-code.ts`: `CLAUDE_CODE_PROVIDER`, `ClaudeCodeStatus` (adds the state `"not-configured"`), `CLAUDE_CODE_MINIMUM_VERSION`.
- Create:
  - `src/agent/claude-code/runner-client.ts`.
- Do **not** port `binary.ts`, `installation.ts`, `launch.ts` or `externalCliEnv` use.
- Tests, ported and adapted:
  - `tests/claude-code-stream.test.ts`, `claude-code-transcript.test.ts`, `claude-code-tool-bridge.test.ts`, `claude-code-provider.test.ts`, `claude-code-context-window.test.ts`.
  - New: `tests/claude-code-runner-client.test.ts`.
- `package.json`/lock: add `"@modelcontextprotocol/sdk": "1.32.1"` with an exact pin.

**Interfaces:**
- Consumes: `deploy/claude/runner.mjs` `createRunner` and `toClaudeArgs` (tests only).
- Produces:
  - `type ClaudeRunRequest = { model: string; effort: AnthropicEffort; systemPrompt: string; mcp: { url: string; authorization: string }; allowedTools: string[] }`.
  - `interface ClaudeChild { stdin: Writable; stdout: Readable; stderr: Readable; kill(signal?: NodeJS.Signals): boolean; once(e: "close", f: (code: number | null) => void): this; once(e: "error", f: (err: Error) => void): this }`.
  - `type RunClaude = (request: ClaudeRunRequest, options: { signal?: AbortSignal }) => Promise<ClaudeChild | null>`.
  - `createClaudeCodeStreamFunction(runClaude: RunClaude)`.
  - `createRunnerClient({ addr: string, token: string }): RunClaude`.
  - `runnerStatus({ addr, token }): Promise<ClaudeCodeStatus>`.
  - `createClaudeCodeProvider(streamSimple)`, `CLAUDE_CODE_MODELS`.
  - `ToolBridge.mcp: { url: string; authorization: string }`, replacing upstream's `mcpConfig` string.
  - `createToolBridge(tools, callbacks?, { host })`, where host is `process.env.CLAUDE_BRIDGE_HOST ?? "127.0.0.1"`.

- [ ] **Step 1: Port the five upstream test files.**
  - Change each `createFakeRun` so its `RunClaude(request)` writes `request.systemPrompt` and the MCP config built from `request.mcp` into a temp dir, then spawns `fake-claude.mjs` with `toClaudeArgs` imported from the runner.
  - Assertions on `RunCall.args` stay as they are.
- [ ] **Step 2: Write `tests/claude-code-runner-client.test.ts`.** It runs a real `createRunner`, with `appHost` `127.0.0.1` and the fake CLI, behind `createRunnerClient`:
  - `a text turn streams through the runner`: the events end with `done`, and the text matches `text.jsonl`.
  - `a tool turn round-trips over the bridge`: `tool.jsonl` admits one call and the result reaches the fake.
  - `signed-out CLI fails readably`: the error message equals `CLAUDE_CODE_NOT_SIGNED_IN_COPY` (below).
  - `unreachable runner fails readably`: the address is a closed port, and the error equals `CLAUDE_CODE_UNREACHABLE_COPY`.
  - `abort kills the remote process`.
- [ ] **Step 3:** Run both files. Expected: FAIL.
- [ ] **Step 4:** Port the modules and implement `runner-client.ts`.
  - Use a `net.Socket` and `node:readline` on the socket.
  - Feed `stdout` and `stderr` frames into `PassThrough` streams.
  - `stdin` is a `Writable` that sends `{"stdin": line}` frames, one per `\n`-terminated chunk; `end()` sends `endStdin`.
  - `kill(sig)` sends a `signal` frame, and `close` is emitted from the `exit` frame or from the socket closing (code `null`).
  - Error frames map to copy:
    - `unauthorized` or `invalid` give `"Claude Code runner refused the request."`;
    - `busy` gives `"Claude Code is busy with another chat. Try again in a moment."`;
    - `update_required` gives `"Claude Code needs an update."`.
  - Exact copy constants in `constants.ts`:
    - `CLAUDE_CODE_NOT_SIGNED_IN_COPY = "Claude Code isn't signed in. Run `docker exec -it learnharness-claude-1 claude` on the server and use /login."`;
    - `CLAUDE_CODE_UNREACHABLE_COPY = "Claude Code isn't reachable. Check the claude container."`.
  - In `stream.ts`:
    - `startProcess` builds `ClaudeRunRequest` from `toClaudeInput` and `bridge.mcp`. No local files: `createTurnFiles` and `removeTurnResources` shrink to the bridge close.
    - The reuse `configuration` drops `env`.
    - `getAssistantErrorMessage` maps `authentication_failed` to `CLAUDE_CODE_NOT_SIGNED_IN_COPY`.
- [ ] **Step 5: Verify.** The ported and new tests pass, and so do `npm test`, `npm run typecheck` and `npm run lint`. The lint law holds: `src/agent` imports neither server nor store.
- [ ] **Step 6: Commit** `feat(claude-code): engine port over the runner client`.

### Task 3: Server wiring — toggle, gate, catalog, pricing
**Files:**
- Modify:
  - `src/core/contracts/admin.ts`: `AdminPolicy.claudeCode?: { enabled: boolean }`.
  - `src/server/policy.ts`, plus its store if writes need it: `claudeCodeEnabled(): boolean` and `setClaudeCodeEnabled(on: boolean): void`.
- Create:
  - `src/server/claude-code.ts`:
    - `claudeCodeRefusal(spec, opts): Error | null`;
    - `installClaudeCodeSource()`;
    - `claudeCodeStatus(): Promise<ClaudeCodeStatus>`, which is `not-configured` when `CLAUDE_RUNNER_ADDR` is unset, else `runnerStatus`.
  - `app/api/admin/claude-code/route.ts`:
    - `GET` → `{ enabled, status }`;
    - `PUT {enabled: boolean}` → `{ enabled }`.
    - Both are `withTenant` and `requireAdmin()`; a non-admin gets 403.
- Modify:
  - `src/agent/models.ts`: `configureProviderSource` becomes `addProviderSource(source)` over a list.
    - `isCustom` keeps meaning the custom endpoint.
    - `sync` runs every source.
    - Re-installing a source with the same `id` replaces it, so add `id: string` to `ProviderSource`.
    - Update the custom provider's install and its tests.
  - `src/server/stores.ts`: call `installClaudeCodeSource()`. Its `sync` registers `createClaudeCodeProvider(createClaudeCodeStreamFunction(createRunnerClient(env)))` when `claudeCodeEnabled() && CLAUDE_RUNNER_ADDR`, and deletes it otherwise.
  - `src/server/model-gate.ts` `modelGate`: first line `const refusal = claudeCodeRefusal(spec, opts); if (refusal) throw refusal;`, before the admin early-return.
    - The refusal is `ModelNotAllowedError(modelKey(spec))` when the toggle is off, when the caller is a non-admin in multi-user mode, or when the turn-only rule in Global Constraints fails.
  - `src/server/chat-handler.ts`:
    - The gate call at line ~300 passes `{ purpose: <the turn purpose as at line 420>, chatId, chatKind }`.
    - When `conversation.provider === CLAUDE_CODE_PROVIDER`, the compaction engine uses `effective.models.strong`, skipping compaction when that is unset.
  - `src/server/pricing.ts` `createPricer`: `claude-code` → `null`.
  - `src/server/model-catalog.ts`:
    - `catalogModels()` and `catalogProviders()` exclude `claude-code`.
    - `modelCatalog()` appends `CLAUDE_CODE_MODELS` DTOs with `cost: null` when the toggle is on and the ambient tenant is admin.
    - `validateModelsSettings` refuses a `claude-code` slot with `"Claude Code models can't be used as a model slot."`.
    - `validateChatSettings` refuses `claude-code` for non-admins.
  - `src/server/policy.ts` `validatePolicy`: refuses a `claude-code:` key in slots or `allowedModels`.

**Interfaces:**
- Consumes (Task 2): `createClaudeCodeProvider`, `CLAUDE_CODE_MODELS`, `createClaudeCodeStreamFunction`, `createRunnerClient`, `runnerStatus`, `CLAUDE_CODE_PROVIDER`.
- Produces: `GET`/`PUT /api/admin/claude-code` and `claudeCodeEnabled()`, for Task 4.

- [ ] **Step 1: Write the failing tests** in `tests/claude-code-admin.test.ts`. Use an isolated `LH_DATA_DIR`, dynamic imports and the tenant context helpers used by the model-gate tests.
  - `gate refuses non-admins even when allow-listed`: a restricted user's policy is hand-written with `claude-code:sonnet` in `allowedModels`, `modelGate(spec, {purpose:"teacher", chatId:"c"})` throws `ModelNotAllowedError`, and `validatePolicy` rejects that policy.
  - `gate refuses background purposes for admins`: an admin is refused for each of `{purpose:"compaction", chatId}`, `{purpose:"teacher", role:"teacher", chatId}` and `{purpose:"teacher"}` with no chatId.
  - `gate admits an admin chat turn only when enabled`: `{purpose:"prober", chatId}` passes when enabled and throws when disabled.
  - `demoted admin's pinned chat is refused`: a chat record whose settings model is `claude-code:sonnet`, run through `handleChatRequest` as a non-admin, gets 403 `model_not_allowed`, and the chat file is byte-identical afterwards. (Review Focus 1.)
  - `toggle off mid-question refuses the answer turn readably`: the admin starts a turn on claude-code with a faux engine, the toggle is turned off, and the answer POST gets 403 `model_not_allowed` with no crash. (Review Focus 2.)
  - `catalog lists claude-code only for an enabled admin`, with `cost === null`.
  - `pricer leaves claude-code unpriced`: `callCost({input:1000, output:1000}, "claude-code:sonnet") === null`.
  - `slots refuse claude-code`.
  - `admin route is admin-only`: a non-admin's GET and PUT get 403, and an admin's PUT round-trips `enabled`.
  - `compaction of a claude-code chat runs on the strong slot`: the compaction engine's `model.provider !== "claude-code"`.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement the changes listed in Files.
- [ ] **Step 4: Verify.** The file passes, and so do `npm test`, typecheck and lint. The golden fixtures are unchanged.
- [ ] **Step 5: Commit** `feat(claude-code): admin toggle, gate, catalog and pricing`.

### Task 4: Settings UI and release prep
**Files:**
- Create:
  - `components/settings/claude-code-section.tsx`, modelled on upstream `components/settings/claude-code-status.tsx`. It is rendered only for admins, in the same place the custom endpoint editor sits, and contains:
    - a toggle "Use Claude Code (experimental)";
    - a status line from `GET /api/admin/claude-code`:
      - `meets-minimum` → "Claude Code {version} ready";
      - `not-configured` → "Not set up on this server";
      - `not-found` or unreachable → "The claude container isn't running";
      - `update-required` → "Needs an update ({version} < {minimumVersion})";
    - a fixed note: "Runs on the account logged into the claude container. Only you can use it; usage isn't priced."
  - `tests/claude-code-section.test.tsx`: render tests for each status line and the absent-for-non-admin case.
- Modify:
  - The slot pickers (`components/settings/model-menu.tsx`, or wherever slot options are built) filter out `provider === "claude-code"`. The chat model picker keeps them.
  - Wherever the picker shows a model's price: a `claude-code` model shows "subscription" in place of a price, never "$0". Add a render test.
  - `package.json` version `0.40.0`.

- [ ] **Step 1:** Write the render tests. **Step 2:** Run them, expecting RED. **Step 3:** Implement.
- [ ] **Step 4:** Run the full gate line: `npm run typecheck && npm test && npm run lint && npm run build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs`.
- [ ] **Step 5: Commit** `feat(claude-code): admin settings section (0.40.0)`.

### Task 5: Deploy and live check (controller)
1. Take a snapshot, `pre_claude_code_0_40_0`, then merge.
2. Run `nixos-rebuild test`, check that a fresh SSH session works, then run `switch`, because the stack script changed.
3. Run `systemctl restart learnharness-stack` and check:
   - health;
   - `docker exec learnharness-claude-1 sh -c 'ls /data; env | sort'`: `/data` is absent and the env holds only the allowed variables;
   - a non-admin probe of `/api/models` has no `claude-code` entries.
4. Hand the owner one command for the login: `ssh -t root@learnharness.fritz.box docker exec -it learnharness-claude-1 claude`, then `/login`.
5. After the login, run one admin chat turn on `claude-code:sonnet` that uses a LearnHarness tool, and check that the request log line has tokens and no `providerCostUsd`.
6. Tag v0.40.0, publish the release, and update memory.
