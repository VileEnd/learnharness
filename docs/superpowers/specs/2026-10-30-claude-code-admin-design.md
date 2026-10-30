# Claude Code as an admin-only model provider (experiment)

## Context and owner decisions
Upstream (amosblomqvist/learnharness 0.4.0) can use the local `claude` CLI (Claude Code) as a model provider. It reaches the CLI through `RunClaude` (src/agent/claude-code/stream.ts) and passes LearnHarness's own tools to it through a per-turn MCP bridge (tool-bridge.ts). The CLI runs on whatever account it is logged into, which in practice is a Claude Pro/Max subscription.

The fork is multi-user, which changes the risk:
- every user would share one person's subscription;
- spending caps cannot see this usage, because it is unpriced;
- the CLI would run inside the container that holds every user's data and the app secrets.

**Owner rulings (2026-10-30):**
- **Admin-only experiment.** It is never offered to other users, it is visibly unpriced, and the CLI runs in its own locked-down container.
- **Chat turns only.**
- **Off by default.**
- **Separate container (confirmed 2026-10-30):** the owner asked whether the CLI could run in the shared app container. Told the trade-off, they chose the separate container.

I advised against this: Anthropic's Consumer Terms §2 and the Claude Code credential policy forbid sharing a Pro/Max login with other users. The owner chose the admin-only variant knowing it is a grey area. Background work (extraction, research, demos, compaction) keeps using the API models.

## Design

### A separate `claude` container
- **Image:** a new compose service, built from `deploy/claude/`. It contains:
  - `node:26-slim`;
  - `@anthropic-ai/claude-code`, pinned to an exact version at least 2.1.259 and at least two weeks old;
  - `DISABLE_AUTOUPDATER=1`;
  - a small dependency-free **runner** (`deploy/claude/runner.mjs`).
- **What it can reach:**
  - It has **no** `/data` mount, **no** app secrets, **no** Keycloak or OCR tokens and no database access.
  - Its only volume is `./volumes/claude` → `CLAUDE_CONFIG_DIR`, which holds the CLI login.
  - Its only env vars are `CLAUDE_RUNNER_TOKEN`, `DISABLE_AUTOUPDATER` and `HOME`.
- **Networks:**
  - A dedicated compose network `claude-bridge` that contains only `learnharness` and `claude`. Caddy has no route to either port.
  - Plus outbound internet to api.anthropic.com. The VM's LAN egress isolation still applies.
- **Login:** the owner logs in once with `docker exec -it learnharness-claude-1 claude`, then `/login`.
  - The login stays in `volumes/claude`.
  - It is excluded from any backup (the future restic job), so it never leaves the VM.
- **Runner protocol**, on `claude-bridge` only, authenticated by `CLAUDE_RUNNER_TOKEN` (generated into `secrets.env` like the other secrets). It is a plain TCP connection carrying one JSON frame per line, full duplex, because a live CLI process outlives one request: its stdin keeps receiving lines and its held MCP calls wait for the learner. The frames are pinned in the plan.
  - `status`: the CLI version and whether it meets the minimum.
  - `run`: `{model, effort, systemPrompt, mcp: {url, authorization}, allowedTools}`, then stdin, stdout and stderr frames, and an exit frame.
    - The runner builds the argument list **itself**, from upstream's fixed flag set in `toClaudeArgs`: `--tools ""`, `--strict-mcp-config`, hooks off, slash commands off, `--no-session-persistence`, `--permission-prompts none`.
    - It writes its own temp system-prompt and MCP-config files at mode 0600 in a private temp dir.
    - It spawns `claude -p …` with a minimal env.
    - It streams stdout as NDJSON and accepts more stdin lines (stream-json) over the same request.
    - It kills the process when the request is cancelled.
  - Values are validated:
    - model ∈ {opus, sonnet, haiku};
    - effort ∈ the known set;
    - allowedTools must match `^mcp__learnharness__[a-z_]+$`;
    - the MCP URL must point at the app on `claude-bridge`.
  - No caller-supplied flags.
- **Concurrency:** one process per active turn, capped at 2 concurrent (admin only).

### App side (port of upstream, adapted)
- **What is ported:** upstream's `src/agent/claude-code/*`: stream, transcript, tool-bridge, live-processes, cli-events, context-window and provider.
  - `RunClaude` is implemented by a **runner client** in place of a local spawn.
  - `binary.ts`, `installation.ts` and `launch.ts` are replaced by the runner's `/status`.
- **The MCP tool bridge:**
  - It listens on the app container's `claude-bridge` address only (`CLAUDE_BRIDGE_HOST`, a static compose IP), not on loopback, on an ephemeral port per process.
  - Each process gets a random 32-byte bearer token.
  - Upstream's per-call admission (`claudecode/toolUseId` must match the streamed intent) and its MCP cancellation are kept.
- **Admin-only, global:**
  - The toggle `claudeCode.enabled` lives in the global admin config (admin-only API) and defaults to off.
  - Models `claude-code:opus|sonnet|haiku` are listed only for admins.
  - The model gate **hard-refuses** them for every non-admin, regardless of allow-lists, and for every background purpose (any role other than the conversation and teacher/prober/practice purposes).
  - They cannot be set as model slots. They can be picked as a chat's model by an admin only.
- **Compaction:** a chat on a Claude Code model compacts on the admin's strong slot, never on the CLI.
- **Usage:** token counts are recorded, but the CLI's `total_cost_usd` is ignored for subscription use. Usage shows as "subscription, no price" and is never $0. Caps don't apply because admins are uncapped.
- **Failures:** if the CLI or the runner is down, or the quota is exhausted, the turn fails with a readable message. The 0.35.0 Retry and the chat's model switch let the admin continue on an API model.

### Deliberately not ported
- f69fa35's namespace reservation, beyond what the gate needs.
- Upstream's desktop and Electron bits.
- The subscription-plumbing coupling (`connectionBackgroundAllowed` and similar), which the fork removed.

## Verification
- **Unit tests:** runner argument building and validation, the token check, and cancellation.
- **Gate tests:**
  - non-admins are refused claude-code models even when they are allow-listed;
  - background roles are refused;
  - slots reject them.
- **Tool bridge:** admission and token tests, ported from upstream.
- **Live:** after deploy and the owner's login, one admin chat turn on `claude-code:sonnet` that calls a LearnHarness tool, for example the graph search.
  - The request log shows tokens with no price.
  - A non-admin's `/api/models` has no claude-code entries.
  - From inside the claude container, `/data` and the app secrets are absent: `ls /data` fails and `env` shows only the three variables.
