# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` applies in full. In short: this is Next.js 16, which differs from older versions, so read the relevant guide in `node_modules/next/dist/docs/` before writing Next code. Never guess a design or implementation decision. Investigate, ask with AskUserQuestion (one question per call), get the plan approved, then implement.

## What this is

LearnHarness is a self-hosted, browser-only learning app: a Next.js standalone server in Docker, behind Caddy + oauth2-proxy + Keycloak (`deploy/`, `docs/self-hosting.md`), installable as a PWA. (This is a fork; the upstream Electron desktop shell and the ChatGPT/Copilot/Grok subscription connections were removed.) A prober agent assesses the learner, then a teacher agent authors a plan tree and teaches with quiz/ask questions. Separate practice sessions pose problems. Teaching sessions accumulate into a persistent knowledge graph of propositions and reasoning chains, and the graph is the home page. The LLM engine is pi-ai (`@earendil-works/pi-ai` / `pi-agent-core`), and the AI SDK's `UIMessage` is kept as the client wire protocol. Users bring their own provider keys (BYOK), and models come from settings slots (strong/cheap/vision), not env.

## Commands

```bash
npm run dev            # http://localhost:3000
npm run dev:fresh      # new-user simulator: empty .fresh-data/, env keys hidden, port 3005 (ports 3000–3004 refused)
npm run build          # standalone output

npm test               # full suite: node:test via tsx, deterministic (no LLM, no network)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint; its only job is the import law (see below)

# single test file / single test
NODE_ENV=test npx tsx --test tests/chat-flow.test.ts
NODE_ENV=test npx tsx --test --test-name-pattern="<regex>" tests/chat-flow.test.ts

# Python tests for the standalone data skill (skills/learnharness/), separate from the app suite
python3 -B -m unittest discover -s tests/skills -v

# standalone packaging checks (CI order, after npm run build; the Dockerfile runs them too)
node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs

# the image and the full stack
docker build -t learnharness:local .
cd deploy && cp .env.example .env && docker compose up -d --build

# the production VM (home Proxmox VM 104): OpenTofu + NixOS, see docs/self-hosting.md §1
deploy/proxmox/tofu.sh plan|apply        # needs ~/.config/learnharness/proxmox.env (token + state passphrase)
nix run github:NixOS/nixpkgs/nixos-26.05#nixos-rebuild -- switch --flake ./deploy/nixos#learnharness --target-host root@learnharness.fritz.box
ssh root@learnharness.fritz.box systemctl restart learnharness-stack   # redeploy the app from main
```

Gates on every change: typecheck, all tests, lint, and `next build` must be clean; CI also builds and boots the Docker image. CI runs Node 26.

## Architecture

Canonical spec: `docs/architecture.md` (layers, systems, invariants, seam directory). Design decisions are in `docs/vision.md`. Deployment is in `docs/self-hosting.md`. Note: architecture §7 is kept as history for an older problem-set pipeline (`data/practice`, `/practice`, `practice-pipeline.ts`) that no longer exists. Practice is now a chat session kind (`ChatRecord.kind === "practice"`; absent means teach), with its own prompts in `src/agent/prompts/practice/` and tools `problem`/`conclude` in `src/agent/tools/practice.ts`. Practice sessions do no extraction and write nothing to the graph.

### Layers and the import law (lint-enforced)

```
app/          SHELL   route handlers (transport) + pages     → may import @/src/core and @/src/server barrels ONLY
components/   SHELL   UI (render only)                        → may import @/src/core barrel ONLY
src/server    SERVER  composition roots + named seams, no business logic
src/agent     AGENT   prober/teacher/practice agents, tools, prompts, sub-agents, extraction → never imports server/store
src/core      CORE    pure domain: contracts/, ports.ts, merger/derivation, coverage, plan-tree… → never imports agent/server/store
src/store     STORE   fs adapters implementing core ports; the only code touching data/
```

- Two barrels form the whole public API: `src/core/index.ts` (browser-safe only; node-bound modules like `graph.ts` and `coverage.ts` are deliberately excluded, so server code imports them directly) and `src/server/index.ts`.
- Two composition roots: `src/server/stores.ts` (instantiates storage adapters) and `src/server/chat-handler.ts` (wires one turn). The agent layer gets every dependency through factories (`createTeacherAgent`, `createTeacherTools`, `createJobRunner`, `createExtractionPipeline`, …).
- `tests/` and `scripts/` are outside the lint law.
- `tsconfig` is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type`). Relative imports use explicit `.ts` extensions.

### Key runtime mechanisms

- **Turn pipeline** (`handleChatRequest`): one turn per chat (`turn-liveness.ts`; a concurrent POST gets 409 and the client retries). The record is persisted write-ahead before streaming. Agents are stateless and rebuilt per turn from the persisted record (`src/server/pi/`: record → pi messages, pi events → UIMessage SSE). The first `probe_done` part in a transcript switches the prober to the teacher.
- **Client-side question tools**: `quiz`/`ask_user_question` have no server `execute`. The browser grades via `core/question-core` and returns the result as the tool output. Option shuffling is seeded by toolCallId.
- **Plan tree**: authored once via `plan_init` (a mermaid subset, parsed deterministically). Statuses are derived from tagged quiz calls and never mutated.
- **Ack-and-steer jobs**: `research`/`demo`/`visual`/`pdf` return an immediate ack. Demo verification launches a system Chrome/Chromium via puppeteer-core (`CHROME_PATH`; the image installs Chromium). A background runner finishes and builds a steer message, and the wake pipeline (`src/server/jobs.ts`) delivers it exactly once as a server-side turn (deterministic `steer_<jobId>` ids).
- **Knowledge graph**: the extraction pipeline (extractor → auditor → deterministic merger in `core/graph.ts`) is the **sole graph writer**. It is triggered when a chat's uncovered teacher-prose tokens exceed `graph.extractionChunkTokens`, and it runs serially per source. Ledgers in `data/graph/*.jsonl` are append-only. `GET /api/graph` is a pure derivation (`deriveView`). The one sanctioned non-pipeline write is `PUT /api/graph/positions`.
- **Documents**: imports go through the document library (`DocumentStore`, `data/documents/<docId>/`, `src/server/documents.ts`, `POST /api/documents/{check,import}`). Identity is content (`docId` from the PDF bytes or the normalised text, never the filename); a repeat is skipped by default, with Replace / Import as new as the learner's overrides. This reverses the earlier "always re-extract" rule (the dedup lives in the document service, in front of the extraction pipeline, which still processes whatever it is handed). PDFs go through the optional OCR sidecar (`OCR_URL`). Library text is searchable (`src/core/doc-search.ts` BM25 + `src/server/doc-index.ts` embeddings via OpenRouter, merged by RRF; keyword-only without a key, never blocking) and the agents read it through `search_documents` / `read_document` / `list_documents` (`src/agent/tools/documents.ts`, gate `agent.documentTools`). Stored documents are extracted along their own sections (section-aware chunking; each proposition carries `topics` and `section`); topic membership is the append-only `data/graph/topics.jsonl`, written only by the merger, with a pre-extraction alias table (`topic-aliases.json`) folding variant spellings; the graph can group by source or by topic (`groupBy` render setting, layout stays source-based). A re-uploaded original of an old import (file name → legacy `src_` id, nodes, no document) is attached to its existing graph source without re-extraction.
- **Push events**: one SSE channel (`GET /api/events`, bus in `core/events.ts`). Events only notify; consumers then refetch from normal endpoints. Content writers like `saveMessages` deliberately emit nothing.
- **Prompts**: `src/agent/system-prompt.md` (shared base), plus numeric-prefixed `*.md` fragments per agent directory in sorted order, plus a `shared/` appendix. Only files matching the numeric prefix enter the prompt (see `src/agent/prompts/README.md`). Tool field names cited in prompts must match the schemas verbatim.
- **Access control lives outside the app**: there is no auth in the Next server (no `proxy.ts`); every `/api/*` route trusts its caller. Only Caddy publishes ports, and it forwards a request only after oauth2-proxy accepts the Keycloak session (group `learnharness`). The web manifest and icons are deliberately public. Never publish the app container's port directly.

### Invariants to preserve

- The persisted record is the only source of truth. State is derived at read time, never dual-tracked.
- Idempotency comes from deterministic keys (steer ids, coverage fingerprints, path-hash source ids).
- LLMs judge and code mechanizes. A failed LLM stage checkpoints nothing.
- Side-channel failures (extraction, usage, naming) are contained and never touch the response or the persist.
- Absent values (tokens, prices) render as absent, never as zero.
- Records stamped with a newer schema `version` than the build are refused on read.

## Data and tests

- `data/` (or `$LH_DATA_DIR`; `/data/data` in the image) holds plain JSON/JSONL records and is never committed. `LH_AUTH_FILE` relocates the BYOK key store (`/data/auth.json`). `.env.local` holds dev secrets only. `deploy/.env` and `deploy/volumes/` are git-ignored.
- Tests inject engines with pi-ai's faux provider (`createFauxCore`/`fauxAssistantMessage`/`fauxToolCall`) and stub `globalThis.fetch` where transport matters. Render tests use `renderToStaticMarkup` with no DOM library. Some suites set an isolated `LH_DATA_DIR` before any config-loading import, which means app-module imports must be dynamic. Others use the real `data/` with backup-and-restore.
- **Fixture law**: `tests/fixtures/golden-data/` is a real data dir produced by the app and never hand-edited. Any intentional on-disk format change must update these fixtures in the same commit, regenerated by running the app (see its README). `tests/golden-fixtures.test.ts` enforces this.
- Native binaries (`@napi-rs/canvas`, `@resvg/resvg-js`) are traced for the build platform, so the image builds its own payload; never copy a standalone tree in from another OS. `scripts/migrate-subscription-routes.ts` rewrites desktop-era subscription model routes in a migrated data dir.
