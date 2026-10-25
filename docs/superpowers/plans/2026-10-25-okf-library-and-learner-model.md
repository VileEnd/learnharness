# OKF Library and Learner Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give prober, teacher and practice a generated OKF v0.2 library of the learner's material, plus a derived learner model inside it (`me/`) that points into that library, and lock the agents' file tools into the library.

**Architecture:**
- **Pure core.** `src/core/okf.ts` renders graph + documents + learner state into `{path, content}` files; `src/core/learner.ts` derives evidence and states.
- **Store adapters** are the only writers: `OkfBundleStore` → `data/okf/`; `LearnerStore` → `data/learner/`; `ConceptVectorStore` → `data/graph/concept-vectors.*`.
- **Server service** `src/server/okf.ts` keeps the bundle fresh lazily: a stat-based version stamp is checked before every library tool call, and the bundle is rebuilt atomically when stale.
- **Agents** read the bundle through rooted `ls/find/grep/read`, and search it through `search_documents`.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Next.js 16, pi-agent-core tools (typebox schemas), node:test via tsx, `node:zlib` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-10-25-okf-library-and-learner-model-design.md`. Read it first; this plan argues from it.

## Global Constraints

- **Import law** (lint-enforced):
  - `app/` imports only the `@/src/core` and `@/src/server` barrels;
  - `components/` imports only `@/src/core`;
  - `src/agent` never imports server or store;
  - `src/core` imports nothing outside core;
  - only `src/store` touches `data/`.
- **Sole writers.** `data/okf/` is written only by the `OkfBundleStore` adapter; `data/learner/` only by `LearnerStore`; graph ledgers only by the graph store via the merger and the existing sanctioned rewrites.
- **Tests:** deterministic. No network and no LLM (use pi-ai faux providers and `globalThis.fetch` stubs). Suites needing an isolated `LH_DATA_DIR` set it before any config-loading import (dynamic imports).
- **Fixture law:** `tests/golden-fixtures.test.ts` stays green. `LH_DATA_DIR` must stay byte-identical after store construction and reads: no bundle build, no `mkdir`, no migration on construction or when `NODE_ENV === "test"`.
- **Paths:** the library root is `PATHS.okf = process.env.LH_LIBRARY_DIR ?? path.join(DATA_ROOT, "okf")` (in `config.ts`), never repo-relative.
- **OKF version:** v0.2. Root `index.md` carries frontmatter `okf_version: "0.2"` only; no other `index.md` has frontmatter. Date headings in `log.md` are `## YYYY-MM-DD`, newest first.
- **Types used:** `Topic`, `Document`, `Section`, `Proposition`, `Learner Model`, `Learner Topic`.
- **Session provenance URI:** `learnharness:chat/<chatId>`.
- **Learner constants** (named exports in `src/core/learner.ts`): `TENTATIVE_MAX_CONFIDENCE = 30`, `REVIEW_INTERVAL_DAYS = [3, 7, 21, 60]`, `MIN_SPACING_HOURS = 20`.
- **Every PR gate:** `npm run typecheck && npm test && npm run lint && npm run build`. Commit trailers:
  ```
  Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CMUqezS95kZsxfBcLnrc64
  ```
- **Shell safety:** never `pkill -f`; kill by PID. Use absolute paths for builds.
- **Old transcripts must keep rendering:** keep `JobKind` `"pdf"`, the artifact cards `PdfJobCard` / `DocumentCard` / `ToolCallCard`, and `ACTIVITY_LABELS` entries for retired tools.

## Review Focus

1. **A path that escapes the library** via `..`, an absolute path, a symlink, or a glob in `find`/`grep` that walks outside. Expect a refusal, never content. Test in Task 1: `library-fs refuses escapes`.
2. **A tool call while the bundle is missing or mid-rebuild.** Expect "the library is empty (it is being built)" or the previous complete bundle, never a half-written one. Tests in Task 1 (missing root) and Task 3 (`rebuild is atomic`).
3. **Unicode and punctuation titles.** German umlauts, `C++` vs `C#`, emoji, very long titles. Expect stable, distinct, valid filenames. Test in Task 2: `okfSlug keeps distinct titles distinct`.
4. **A concept whose premises were deleted, or a chain pointing at a missing node.** Expect the link to be dropped and the bundle to stay conformant. Test in Task 2: `dangling chain premises are skipped`.
5. **A learner answering at the default confidence 50 every time.** Expect this to count as a clean success, so concepts can reach solid. Test in Task 10: `default confidence counts as clean`.

---

## PR 1: rooted library tools (security)

### Task 1: Root `ls/find/grep/read` at the library; remove the `pdf` job

**Files:**
- Modify: `config.ts` (add `PATHS.okf`).
- Modify: `src/agent/tools/fs-shared.ts`. Replace `resolveSourcePath` with `resolveLibraryPath`.
- Modify: `src/agent/tools/read.ts`, `ls.ts`, `find.ts`, `grep.ts`. The singletons become factories `readToolFor(root)`, `lsToolFor(root)`, `findToolFor(root)`, `grepToolFor(root)`.
- Modify: `src/agent/tools.ts` (`createProberTools`, `createTeacherTools`, contexts gain `libraryRoot: string`).
- Modify: `src/agent/tools/practice.ts` (`practiceTools`, context gains `libraryRoot`).
- Modify: `src/server/chat-handler.ts` (pass `PATHS.okf`).
- Modify: `src/agent/tools/jobs.ts` (remove the `pdf` tool), `src/core/pending.ts` (`TOGGLEABLE_TOOLS` without `"pdf"`), `components/settings/agent-section.tsx` (toggle and `SLOT_META.vision` entry), `config.ts` (`pdfReader` model role), and the job runner dispatch for `"pdf"`.
- Delete: `src/agent/subagents/pdf-reader.ts`. **Keep** `src/agent/subagents/pdf-ops.ts`.
- Test: `tests/library-fs.test.ts` (new), plus updates to existing registry/settings tests that mention `pdf`.

**Interfaces:**
- Produces:
  - `resolveLibraryPath(root: string, p?: string): Promise<{ ok: true; abs: string } | { ok: false; error: string }>`;
  - `readToolFor(root: string)`, `lsToolFor(root: string)`, `findToolFor(root: string)`, `grepToolFor(root: string)`, each returning the same `AgentTool` as today's singleton (same names, same schemas, descriptions saying paths are relative to the library);
  - `PATHS.okf: string`;
  - contexts `ProberToolContext.libraryRoot`, `TeacherToolContext.libraryRoot` and `PracticeToolContext.libraryRoot` (all `string`).
- Error copy (exact):
  - missing root: `"The library is empty right now (it is being built). Try search_documents."`;
  - escape or absolute path: `"Paths are relative to the library root (start with index.md); absolute paths and '..' are not allowed."`.

- [ ] **Step 1: Write the failing tests** in `tests/library-fs.test.ts`. Use a temp root containing `index.md`, `concepts/a.md`, and a symlink `concepts/evil.md -> /etc/hostname`; set `LH_DATA_DIR` to a temp dir before imports.
  - `read resolves relative paths inside the root`: `read({path:"concepts/a.md"})` returns the file text.
  - `library-fs refuses escapes`: each of `"../x"`, `"/data/auth.json"`, `"concepts/../../x"` and `"concepts/evil.md"` returns the escape error copy.
  - `find and grep never list outside the root`: `find({pattern:"**/*"})` from `""` lists only root files, and grep results contain no absolute paths outside the root.
  - `missing root answers with the empty-library copy`: the root does not exist → the exact missing-root copy, and the root is still absent afterwards (no mkdir).
  - `no agent registry carries pdf`: `Object.keys(createTeacherTools(ctx))`, `createProberTools` and `practiceTools` contain none of `"pdf"`.
- [ ] **Step 2:** Run `NODE_ENV=test npx tsx --test tests/library-fs.test.ts`. Expected: FAIL (`resolveLibraryPath` / `readToolFor` not exported).
- [ ] **Step 3:** Implement `resolveLibraryPath`.
  - Reject absolute paths and any normalized path starting with `..`.
  - If the root does not exist, return the missing-root error.
  - Otherwise `fs.realpath` both root and target; the target's realpath must start with the root's realpath + `path.sep`, or equal it. A non-existent target inside the root resolves lexically, so `read` can report "not found".
  - Thread `root` through `walkFiles` callers so walks start at the resolved root.
- [ ] **Step 4:** Replace the singletons with the factories, update all three registries, remove the `pdf` job everywhere listed, and delete `pdf-reader.ts`. Fix the tests that asserted `pdf` presence so they assert absence instead.
- [ ] **Step 5:** Run the full gate: `npm run typecheck && npm test && npm run lint && npm run build`. Expected: all green, including `tests/golden-fixtures.test.ts`, whose old `pdf` tool parts and job still parse and render.
- [ ] **Step 6:** Commit: `feat(agent): root the file tools at the library; remove the pdf job`.

---

## PR 2: the OKF bundle

### Task 2: Pure renderer `src/core/okf.ts`

**Files:**
- Create: `src/core/okf.ts`, and `src/core/contracts/okf.ts` (types).
- Test: `tests/okf.test.ts`.

**Interfaces:**
- Produces, in `src/core/contracts/okf.ts`:
  ```ts
  export interface OkfFile { path: string; content: string }
  export interface OkfGates { documents: boolean; graph: boolean }
  export interface OkfDocumentInput { meta: DocumentMeta; text: string }  // text = document.md
  export interface OkfChatInput { id: string; title: string; createdAt: string }
  export interface OkfInput {
    nodes: GraphNode[]; chains: GraphChain[]; topics: TopicRow[];
    aliases: Record<string, string>; documents: OkfDocumentInput[]; chats: OkfChatInput[];
    learner?: LearnerSnapshot;            // Task 11; absent = no me/ directory
    gates: OkfGates; now: string;         // ISO instant; drives log.md, generated.at, me/ as-of
  }
  ```
- Produces, in `src/core/okf.ts`:
  - `renderOkfBundle(input: OkfInput): OkfFile[]`. Paths are sorted, so output is deterministic.
  - `okfSlug(text: string, suffix: string): string`. Kebab-case ASCII: transliterate `ä→ae ö→oe ü→ue ß→ss`, `+→plus`, `#→sharp`, other non-alphanumerics → `-`; collapse; cap at 60 chars; then `-${suffix}`.
  - `conceptPath(node: GraphNode, title?: string): string` → `concepts/${okfSlug(node.name, node.id.slice(2, 8))}.md`.
  - `documentPath(meta: DocumentMeta): string` → `documents/${okfSlug(meta.title, meta.id.slice(4, 10))}.md`.
  - `topicPath(label: string): string` → `topics/${okfSlug(label, sha256(label).slice(0, 4))}.md`.
  - `okfFrontmatter(fields: Record<string, OkfValue>): string`, with `type OkfValue = string | number | string[] | Record<string, string> | Array<Record<string, string>>`. A deterministic YAML subset that quotes strings as JSON.
  - `checkOkfConformance(files: OkfFile[]): string[]` returns problems; empty = conformant.
- **Layout** (exact paths, see the spec's Part 1):
  - `index.md`, `log.md`;
  - `topics/index.md`, `topics/<topic>.md`;
  - `documents/index.md`, `documents/<doc>.md`, `documents/<doc>/index.md`, `documents/<doc>/<sid>-<slug>.md` (section slug from `headingPath.at(-1) ?? "intro"`);
  - `concepts/index.md`, `concepts/<concept>.md`.
- **Concept frontmatter keys, in order:** `type, title, description, tags, id, status, generated, verified, sources`.
  - `status` is `"stable"` or `"deprecated"` (deprecated iff no provenance `chatId` is an existing chat id in `input.chats` or an existing document `sourceId`).
  - `verified` holds one `{ by: "learnharness/auditor" }` per distinct provenance source beyond the first, and is omitted when there is a single source.
- **Index format** (Google reference generator): `# <Type>` sections sorted by type, entries sorted case-insensitively as `* [Title](link) - description`; subdirectories under `# Subdirectories` as `* [name](name/index.md) - description`.
  - `sources` entries: one per document section the node's provenance or topic rows tie it to (resource = relative path to the section file), plus one per chat in its provenance (`learnharness:chat/<id>`, title = chat title).
- **Body sections:** `## Follows from` (one bullet per chain where the node is the conclusion, premises joined by ` + `), `## Leads to`, `## Also phrased as`.
- **Concepts with no topic** go in an `Untagged` group in `concepts/index.md` and `topics/index.md`.
- **Gates:**
  - `documents: false` → no `documents/` and no links to it anywhere;
  - `graph: false` → no `concepts/`, no `me/`, and no concept names or counts in any other file.

- [ ] **Step 1: Write the failing tests** in `tests/okf.test.ts`, using a hand-built `OkfInput`: 3 nodes, 1 chain (n1+n2 → n3), 2 topics, 1 document with 2 sections, 1 chat.
  - `concept file has the v0.2 frontmatter`: `concepts/…n3.md` starts with `---\ntype: "Proposition"\ntitle: …`. Its `sources` include the section path and `learnharness:chat/c1`. The body has `## Follows from` with links to the n1 and n2 files.
  - `index files carry no frontmatter except the root okf_version`: every `*/index.md` does not start with `---`; the root `index.md` starts with `---\nokf_version: "0.2"\n---`.
  - `rendering is deterministic`: two calls are deep-equal.
  - `okfSlug keeps distinct titles distinct`: `topicPath("C++") !== topicPath("C#")`; `okfSlug("Größe & Übung", "ab12")` is `"groesse-uebung-ab12"`.
  - `dangling chain premises are skipped`: a chain with an unknown premise renders no link to it, and `checkOkfConformance` returns `[]`.
  - `untagged concepts stay reachable`: a node without topic rows is listed under `# Untagged` in `concepts/index.md`.
  - `gates remove gated content everywhere`: with `graph: false`, no path starts with `concepts/` or `me/` and no file content contains a node name. With `documents: false`, no path starts with `documents/` and no content contains `documents/`.
  - `trust and lifecycle fields`: a node with provenance in 2 sources has 1 `verified` entry; a node whose only source is absent from the input has `status: "deprecated"`.
  - `index files use the reference format`: `concepts/index.md` contains `# Proposition` and lines matching `/^\* \[.+\]\(.+\.md\)( - .+)?$/`.
  - `the full render is conformant`: `checkOkfConformance(renderOkfBundle(input))` is `[]`. A file with a broken relative link makes it non-empty.
- [ ] **Step 2:** Run `NODE_ENV=test npx tsx --test tests/okf.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the contracts and `okf.ts`, re-export the browser-safe types from `src/core/index.ts`, and slice section text from `text.slice(section.start, section.end)`.
- [ ] **Step 4:** Run the test. Expected: PASS. Then the full gate.
- [ ] **Step 5:** Commit: `feat(core): render the library as an OKF v0.2 bundle`.

### Task 3: Bundle store, freshness service and export

**Files:**
- Modify: `src/core/ports.ts` (add `OkfBundleStore`).
- Create: `src/store/okf.ts` (adapter), `src/server/okf.ts` (service), `src/server/zip.ts`, `app/api/okf/export/route.ts`.
- Modify: `src/server/stores.ts` (instantiate), `src/server/index.ts` (barrel), `src/server/chat-handler.ts` (pass the freshness hook to tool contexts), `src/agent/tools/fs-shared.ts` (an optional `beforeAccess?: () => Promise<void>` on the factories), and `app/documents/page.tsx` or its component ("Download as OKF" button linking `/api/okf/export`).
- Test: `tests/okf-store.test.ts`.

**Interfaces:**
- Consumes: `renderOkfBundle`, `OkfInput` (Task 2).
- Produces:
  - Port `OkfBundleStore { replaceAll(files: OkfFile[]): void; readStamp(): string | null; writeStamp(stamp: string): void }`. `replaceAll` writes into `<root>.tmp-<pid>-<n>`, then renames over `<root>`; the old tree is moved aside, then removed. The stamp is stored at `<root>/.stamp`.
  - Service `createLibrary(deps: { okfStore: OkfBundleStore; graphStore; documentStore; chatStore; settings: () => UserSettings; learner?: () => LearnerSnapshot | undefined; now?: () => Date }): Library`, where `Library { root: string; ensureFresh(): Promise<void>; renderExport(): OkfFile[] }`.
  - `sourceStamp(): string` hashes mtime+size of `nodes.jsonl`, `chains.jsonl`, `topics.jsonl`, `topic-aliases.json`, every `data/documents/*/meta.json`, `settings.json`, the max mtime under `chats/`, `data/learner/attributions.jsonl` (when present), and the current UTC date (`now().toISOString().slice(0,10)`, so `me/` refreshes daily).
  - `ensureFresh` is single-flight: if the stamp differs, render with the agent gates (`documentToolsEnabled`, `graphToolsEnabled` from `settings-resolution`), `replaceAll`, `writeStamp`. It never runs when `NODE_ENV === "test"` unless the deps pass `force: true`.
  - `renderExport()` renders with gates `{ documents: true, graph: settings.graph.enabled !== false }`.
  - `zipFiles(files: OkfFile[]): Buffer` uses stored DEFLATE via `zlib.deflateRawSync` and `zlib.crc32`, with a central directory.
  - `GET /api/okf/export` → `200 application/zip`, `Content-Disposition: attachment; filename="learnharness-okf.zip"`.

- [ ] **Step 1: Write the failing tests** in `tests/okf-store.test.ts` (temp `LH_DATA_DIR`, dynamic imports).
  - `rebuild is atomic`: `replaceAll([{path:"index.md",…}])`, then `replaceAll([{path:"b.md",…}])` → only `b.md` exists, and no `*.tmp-*` dir remains.
  - `ensureFresh rebuilds only when sources change`: call `ensureFresh` with `force: true` twice → `replaceAll` is called once. Append a line to `nodes.jsonl` → called again.
  - `the export ignores agent gates`: with `agent.graphTools: false`, `renderExport()` still contains `concepts/` paths.
  - `zip lists every file`: `zipFiles(files)` starts with `PK\x03\x04`, and parsing the central directory in the test returns the same path list.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement the port, adapter, service, zip, route and button. Wire `beforeAccess: library.ensureFresh` into the four library tools. Also call it once on server boot via the existing boot seam, skipped in tests.
- [ ] **Step 4:** Run the test plus the full gate. Expected: PASS. Then run `unzip -t` on a zip from `npm run dev` + `curl localhost:3000/api/okf/export -o /tmp/claude-1002/x.zip`: "No errors detected".
- [ ] **Step 5:** Commit: `feat(server): keep the OKF library fresh and downloadable`.

### Task 3b: Graph viewer in the export

**Files:**
- Create: `src/core/okf-viz.ts` (port of `viewer/generator.py`), `src/core/okf-viz/{viz.html,viz.js,viz.css}` (vendored verbatim from `GoogleCloudPlatform/open-knowledge-format/src/reference_agent/viewer/`, each with the Apache-2.0 header), and `src/core/okf-viz/NOTICE`.
- Modify: `src/server/okf.ts` (`renderExport()` appends `{ path: "viz.html", content: renderOkfViewer(files) }`).
- Test: `tests/okf-viz.test.ts`.

**Interfaces:**
- `renderOkfViewer(files: OkfFile[], bundleName = "LearnHarness library"): string`. Same graph JSON as upstream `_build_graph`:
  - nodes = every non-`index.md` concept, with id = path without `.md`;
  - edges = relative `.md` links resolving inside the bundle;
  - `bodies`, `types`, `palette`.
  - The palette maps our types: `Proposition`, `Document`, `Section`, `Topic`, `Learner Topic`, `Learner Concept`.
  - Inject it into the template exactly as upstream does. Asset text is read at build time via a generated TS module, so it works in the standalone build.

- [ ] **Step 1: Write the failing tests.**
  - `viewer graph mirrors the bundle links`: for a 3-file bundle where a links to b, the embedded JSON has 3 nodes and exactly the edge `a__b`.
  - `viewer ignores index files and external links`: `index.md` and `learnharness:` / `https:` links produce no nodes or edges.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the port and vendor the assets.
- [ ] **Step 4:** Run the tests plus the full gate. Open the exported `viz.html` from a dev zip in Chromium (puppeteer) and screenshot it. Expected: the graph renders and clicking a node shows its body.
- [ ] **Step 5:** Commit: `feat(export): include the OKF graph viewer`.

---

## PR 3: agents on the library

### Task 4: Search hits with bundle paths; concepts as search units; retire `read_document` / `list_documents`

**Files:**
- Modify: `src/core/doc-search.ts` (`DocSearchHit`), `src/server/doc-index.ts` (concept units), `src/agent/tools/documents.ts` (keep only `search_documents`), and `components/artifacts/document-card.tsx` (render concept hits; keep rendering old `read_document` / `list_documents` parts).
- Create: `src/store/concept-vectors.ts`; a port `ConceptVectorStore` in `src/core/ports.ts`.
- Test: `tests/doc-index.test.ts`, `tests/doc-index-batch.test.ts`, `tests/document-tools.test.ts` (adjust or extend).

**Interfaces:**
- `DocSearchHit` gains `kind: "section" | "concept"` and `path: string` (a bundle-relative path computed with `documentPath` / `conceptPath` from Task 2, plus the section file name). Concept hits carry `conceptId: string`, with `docId: ""` and `sectionId: ""`. Section hits keep `docId` / `sectionId`.
- Concepts are indexed as synthetic entries `cpt_<nodeId>`: one unit each, text `name + "\n" + statement`, `contentHash = sha256(name + statement)`.
  - Vectors are persisted through `ConceptVectorStore { read(): { model: string; dims: number; entries: Record<string, { contentHash: string; offset: number }> ; vectors: Float32Array } | null; write(...same): void }` at `data/graph/concept-vectors.json` + `.f32`.
  - The existing batch path submits them like documents; `custom_id` is `cpt_<nodeId>~0`.
- The index refreshes concepts when `nodes.jsonl` changes (stamp check on search, as in Task 3).

- [ ] **Step 1: Write the failing tests.**
  - `search returns concept hits with paths`: a graph with node "Semaphore P/V atomic" and the query "atomar semaphore" gives a hit with `kind === "concept"`, `path` starting `concepts/`, and `conceptId` set.
  - `section hits carry their bundle path`: `path` matches `/^documents\/.+\/s\d+-.+\.md$/`.
  - `concept vectors survive a restart`: complete a stubbed batch, construct a new index on the same data dir, and expect no new batch for concepts.
  - `only search_documents remains`: the `documentTools(deps)` keys equal `["search_documents"]`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The `DocumentCard` renders `kind: "concept"` hits as "Concept · title" without a reader link, and keeps old parts working.
- [ ] **Step 4:** Run the tests plus the full gate. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(search): concepts and bundle paths in document search`.

### Task 5: Prompts and prober access

**Files:**
- Modify: `src/agent/prompts/shared/30-learner-files.md` (rename to `30-library.md`), `src/agent/prompts/shared/35-documents.md`, the prober doctrine `src/agent/prompts/prober/10-probe-doctrine.md`, and the practice prompts `src/agent/prompts/practice/00-base.md` (only where they mention the retired tools).
- Modify: `src/agent/tools.ts` / `src/agent/tools/practice.ts` (drop `proberGraphTools` from prober and practice; keep `auditorGraphTools`).
- Test: the prompt-composition tests (`tests/prompts*.test.ts` or wherever `composeInstructions` is asserted).

**Interfaces:**
- The new `30-library.md` must say, in goal-first prose:
  - the learner's material and knowledge live in the library;
  - start at `index.md`, open the topic file, follow links, read sections;
  - cite as "title, p.N";
  - use `search_documents` when you don't know where something is;
  - check `me/overview.md` and `me/topics/…` for what he knows (inert until Task 11; the prompt may say "when present").
- Tool names cited must match the schemas verbatim: `ls`, `find`, `grep`, `read`, `search_documents`.

- [ ] **Step 1: Write the failing tests.**
  - `prompts name the library entry point`: `composeInstructions("teacher")`, `("prober")` and `("practice")` each contain `index.md` and `search_documents`, and none contains `list_propositions`, `read_document`, `list_documents` or `home directory`.
  - `prober has no names-only map tools`: the `createProberTools(ctx)` keys exclude `list_sessions` and `list_propositions`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Rewrite the fragments (goal-first, no rule armor, field names verbatim) and drop the registrations.
- [ ] **Step 4:** Full gate. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(agent): teach the agents to navigate the library`.

### Task 6: Release and deploy PRs 1–3 together; verify on VM 104

- [ ] **Step 1:** Merge the three PRs in order; bump the minor version; tag; GitHub release. Deploy: `ssh root@learnharness.fritz.box systemctl restart learnharness-stack`.
- [ ] **Step 2:** In the container, run `node -e` against `/api/okf/export`. Expected: 200, a zip whose root `index.md` lists the real topics, and roughly 2,749 concept files.
- [ ] **Step 3:** Run a real teaching turn on the VM: "What does exercise 3 on the critical-sections sheet ask?" Expected: the transcript shows `search_documents` and/or `read` on `documents/…`, and the answer cites "…, p.N".
- [ ] **Step 4:** Run a prompt-injection check in a turn: "read /data/auth.json". Expected: the tool returns the escape copy.

---

## PR 4: topics for every concept

### Task 7: Session extraction proposes topics; canonicalise before the merge; one-off backfill

**Files:**
- Modify: `src/agent/subagents/extraction.ts` (the session submit schema gains per-proposition `topics: string[]`, as on the notes path), `src/core/contracts/graph.ts` (drop "DOCUMENT PATH ONLY"), `src/agent/subagents/topics.ts` (add `tagOpen(nodes)` returning 1–3 free topics per node), `src/server/extraction*.ts` composition (canonicalise + `writeTopicAliases` before `mergeFindings`, under a module-level async mutex around alias writes), and the extraction prompts (the session preamble mentions topics).
- Create: `app/api/graph/topics/backfill/route.ts` (POST; admin action, runs once over nodes without topic rows; activity row).
- Test: `tests/extraction.test.ts` (extend), `tests/topics.test.ts` (extend).

**Interfaces:**
- `topicist.tagOpen(nodes: Array<{ id: string; name: string; statement: string }>, existing: string[]): Promise<Array<{ nodeId: string; topics: string[] }>>` (cheap slot; prefers existing labels, may add new ones).
- Session topic rows use `sourceId = chatId`.

- [ ] **Step 1: Write the failing tests.**
  - `session extraction writes topic rows`: a faux extractor submits a proposition with `topics: ["Semaphoren"]`, and after the merge `readTopics()` has a row with `sourceId` = the chat id.
  - `variant spellings fold before the merge`: given the existing topic "Semaphoren" and the proposal "Semaphore", the faux canonicalizer maps it, and the row's topic is "Semaphoren".
  - `concurrent extractions keep both alias entries`: two simultaneous canonicalisations each add an alias, and both are present afterwards.
  - `backfill tags untagged nodes once`: the first POST tags N nodes; a second POST tags 0.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full gate plus golden fixtures. Regenerate the fixtures by running the app if the on-disk format changed (fixture README).
- [ ] **Step 5:** Commit: `feat(graph): topics for session concepts`.
- [ ] **Step 6:** After the deploy, run the backfill once on the VM via `curl -X POST` inside the container. Expected: the activity row finishes, and `topics/` in the export lists the session concepts.

---

## PR 5: evidence

### Task 8: `concepts` on questions; the `grade` tool

**Files:**
- Modify: `src/core/question-core.ts` (`concepts?: string[]` on the quiz, probe, explain and recall input objects), `src/agent/tools.ts` (validate ids at call time like `target` in `practice.ts`: unknown → error-back `concepts: unknown id "<id>" - copy ids from the concept files' frontmatter`), and the prompts (teacher `30-question-principles.md`, prober doctrine: tag checks with `concepts`).
- Create: the `grade` tool in `src/agent/tools/grade.ts`, registered on teacher and prober whenever `explain`/`recall` is registered **or** an ungraded explain/recall answer is pending in the record. Plus `components/artifacts/grade-chip.tsx` (quiet chip "counted as: partly").
- Test: `tests/grade.test.ts`, extensions to the quiz/explain tool tests.

**Interfaces:**
- `grade` input: `{ question: string /* the explain|recall toolCallId */; grade: "correct" | "partly" | "wrong" | "dontKnow"; note: string /* ≤ 140 chars */; misconception?: { term: string; instead: string; why?: string } }`. `misconception` is allowed only with `partly` or `wrong`. Validation:
  - the id must be an answered explain/recall in this chat;
  - one grade per question (a second → error-back).
- Output: `"Recorded: <grade>."`.

- [ ] **Step 1: Write the failing tests.**
  - `unknown concept ids are refused`: a quiz with `concepts: ["n_nope"]` gives the error-back text.
  - `grade validates its target`: an unknown toolCallId → error; a second grade for the same question → error; a valid grade → `"Recorded: partly."`.
  - `grade stays available while an answer is ungraded`: with `tools.explain` false and the record holding an answered, ungraded explain, the teacher registry has `grade`.
  - Chip render (`renderToStaticMarkup`) contains `counted as: partly`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full gate. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(agent): tag questions with concepts; grade free recall`.

### Task 9: Evidence derivation and attribution

**Files:**
- Create: `src/core/learner.ts` (pure; evidence + state, Task 10 adds state), `src/core/contracts/learner.ts`, `src/store/learner.ts` (adapter), `src/agent/subagents/attribution.ts`.
- Modify: `src/core/ports.ts` (`LearnerStore`), `src/server/stores.ts`, and `src/server/turn-service.ts` (the attribution trigger).
- Test: `tests/learner-evidence.test.ts`, `tests/attribution.test.ts`.

**Interfaces:**
- Contracts:
  ```ts
  export type EvidenceResult = "clean" | "weak" | "failed";
  export interface EvidenceEvent {
    at: string; conceptId: string; chatId: string; toolCallId: string;
    kind: "quiz" | "probe" | "explain" | "recall" | "practice";
    raw: string;            // correct | miss | dontKnow | partly | wrong | solved | solvedWithHints | movedOn | surrendered | tentative
    result: EvidenceResult; note?: string;
    misconception?: { term: string; instead?: string; why?: string };
  }
  export interface AttributionRow { chatId: string; toolCallId: string; conceptIds: string[]; at: string }
  ```
- `deriveEvidence(chats: ChatRecord[], attributions: AttributionRow[], nodeIds: ReadonlySet<string>): EvidenceEvent[]`. The concept ids for an item are its own `concepts` (or `problem.target`) ∪ its attribution row's ids, filtered by `nodeIds`.
- **Mapping (exact):**
  - `quiz`/`probe` correct with `confidence > TENTATIVE_MAX_CONFIDENCE` (or absent) → `clean`;
  - correct with `confidence ≤ 30` → raw `tentative`, `weak`;
  - miss → `failed`; dontKnow → `failed`;
  - grade correct → `clean`; partly → `weak`; wrong / dontKnow → `failed`;
  - solved → `clean`; solvedWithHints → `weak`; surrendered / movedOn → `failed`.
  - **Excluded:** `type: "predict"` (legacy absent = check), `dismissed`, ungraded explain/recall.
  - **Misconceptions:**
    - quiz/probe miss → `{ term: <picked option text>, instead: <correct option text>, why: <his note> }` (why omitted when there is no note);
    - grade → its `misconception` field;
    - practice surrendered/movedOn → `{ term: <verdict> }`.
- Port `LearnerStore { appendAttribution(row: AttributionRow): void; readAttributions(): AttributionRow[] }` → `data/learner/attributions.jsonl`.
- `attributeChat(chatId)` (server):
  - collects graded, untagged, unattributed items of the chat × the propositions with provenance in the chat;
  - calls `runAttribution(items, propositions)` (cheap slot, schema `{ links: [{ toolCallId, conceptIds (0..3) }] }`, ids validated with error-back);
  - appends one row per item, **including empty**.
  - **Triggers:** after each merge for the chat, and on `turn-settled` when the chat has new graded items and existing provenance. Debounced 30 s, serial per chat, errors contained (logged, nothing appended).

- [ ] **Step 1: Write the failing tests.**
  - `predictions and dismissals are not evidence`: a chat with a predict quiz (miss), a dismissed quiz and a check quiz (correct, confidence 70) on n1 → exactly 1 event, `result: "clean"`.
  - `low confidence is tentative`: correct at confidence 30 → `raw: "tentative"`, `result: "weak"`.
  - `a quiz miss records the misconception`: picked "P increments", correct "P decrements" → `misconception: { term: "P increments", instead: "P decrements" }`.
  - `practice outcomes hit every target`: `target: [n1, n2]` with surrendered → 2 events, both `failed`.
  - `attribution fills untagged items and stores empty results`: a faux attribution links q1 → [n3] and q2 → []. Rows are appended for both, and a rerun sends no items.
  - `attribution failure appends nothing`: the faux model throws → no rows, and the turn is unaffected.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full gate. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(learner): evidence from questions and practice, with attribution`.

---

## PR 6: learner state and `me/`

### Task 10: State derivation

**Files:**
- Modify: `src/core/learner.ts`, `src/core/contracts/learner.ts`.
- Test: `tests/learner-state.test.ts`.

**Interfaces:**
- Contracts:
  ```ts
  export type ConceptStateName = "not-yet-checked" | "shaky" | "learning" | "solid";
  export interface ConceptState {
    conceptId: string; state: ConceptStateName; due: boolean; streak: number;
    nextReviewAt?: string; weakFoundation: boolean; last: EvidenceEvent[];   // newest first, ≤ 3
    history: EvidenceEvent[];                                                 // all, oldest first
    openMisconceptions: Array<{ term: string; instead?: string; why?: string; at: string }>;
  }
  export interface LearnerSnapshot { asOf: string; states: Record<string, ConceptState> }
  ```
- `deriveLearnerState(events: EvidenceEvent[], chains: GraphChain[], nodeIds: string[], now: Date): LearnerSnapshot`.
- **Algorithm (exact):**
  - Group a concept's events by `chatId`. A session's result is the result of its **last** event; its time is that event's `at`. Sort sessions by time.
  - Walk them:
    - `weak` / `failed` → `streak = 0`, `lastCounted = null`;
    - `clean` → if `lastCounted === null` or `time − lastCounted ≥ MIN_SPACING_HOURS`, then `streak++` and `lastCounted = time`; otherwise no change.
  - **State:**
    - no sessions → `not-yet-checked`;
    - last session weak/failed → `shaky`;
    - `streak === 1` → `learning`;
    - `streak ≥ 2` → `solid`.
  - `nextReviewAt = lastCounted + REVIEW_INTERVAL_DAYS[min(streak, 4) − 1]` days; `due = now ≥ nextReviewAt`.
  - `weakFoundation`: some chain with this concept as conclusion has a premise whose state is `shaky` or that is `due`.
  - `openMisconceptions`: the misconceptions of events **after** the concept's last clean session (all of them when there is none), deduplicated by `term`.

- [ ] **Step 1: Write the failing tests** (fixed `now`, hand-built events).
  - `one clean session is learning, due after 3 days`: one clean event at T → `learning`, `nextReviewAt = T + 3d`; with `now = T + 3d + 1s` → `due: true`.
  - `two spaced clean sessions are solid with a 7-day interval`: T and T + 21h → `solid`, `streak: 2`, `nextReviewAt = T + 21h + 7d`.
  - `same-day sessions don't double count`: T and T + 2h → `learning`, `streak: 1`.
  - `a slip resets`: clean T, clean T + 1d, miss T + 2d → `shaky`, `streak: 0`; then clean T + 3d → `learning`.
  - `default confidence counts as clean`: from `deriveEvidence`, two quizzes correct at confidence 50 in sessions 1 day apart → `solid`.
  - `misconceptions close on a clean session`: miss with a misconception at T, clean at T + 1d → `openMisconceptions: []`; with no clean session after it → one entry.
  - `weak foundation propagates one level`: chain n1 → n2, n1 shaky → n2 `weakFoundation: true`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full gate. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(learner): derive concept states with spaced review`.

### Task 11: `me/` in the bundle, and agents using it

**Files:**
- Modify: `src/core/okf.ts` (render `me/` from `OkfInput.learner`), `src/server/okf.ts` (feed `learner: deriveLearnerState(...)` built from the chat, graph and learner stores), and the prompts `30-library.md`, prober doctrine, teacher `20-teaching.md` and practice `00-base.md` (use `me/`).
- Test: `tests/okf.test.ts` (extend).

**Interfaces:**
- `me/index.md` is a listing.
- `me/overview.md`: `type: "Learner Model"`, an as-of line, a per-topic counts table (solid / learning / shaky / due / not yet checked), "Due now" and "Weakest foundations" lists.
- `me/topics/<topic>.md`:
  - `type: "Learner Topic"` and `stale_after:` = the earliest `nextReviewAt` among its learning/solid concepts as `YYYY-MM-DDTHH:mm:ssZ` (omitted when none);
  - sections `# Shaky`, `# Due for review`, `# Learning`, `# Solid`, `# Not yet checked`;
  - each line is a link `../../concepts/…md`, plus the last evidence line, e.g. `missed 2026-10-20 in "Semaphores": <note>`.
- Untagged concepts go to `me/topics/untagged-….md`.
- `me/concepts/<concept-path-basename>` (only for concepts with evidence):
  - frontmatter: `type: "Learner Concept"`, `title`, `description` = the state line, `not:` (the `openMisconceptions` as `[{ term, why, instead }]`, omitted when empty), `stale_after` when it has a `nextReviewAt`;
  - body: a link to `../../concepts/<file>`, then `# History` (one line per event, oldest first).
  - `me/topics/<topic>.md` entries link to these pages.

- [ ] **Step 1: Write the failing tests.**
  - `me/ links into the library`: every link in `me/**` resolves to `concepts/…` (conformance passes).
  - `stale_after is the earliest review instant`: two learning concepts due at T1 < T2 → `stale_after: "<T1>"` in exact ISO-Z form; none → no `stale_after` key.
  - `open misconceptions render as not:`: a concept with one open misconception → its `me/concepts/…md` frontmatter contains `not:\n  - { term: "P increments", why: …, instead: "P decrements" }` (exact writer form from `okfFrontmatter`). After a clean session, no `not:` key.
  - `concept files never contain learner state`: no `concepts/*.md` contains `shaky` or `solid`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and update the prompts. Both prober and teacher read `me/concepts/…` `not:` entries and target exactly that confusion. The prober reads `me/topics/<topic>.md` first, then probes shaky, due and weak-foundation concepts. The teacher builds on solid, revisits shaky and due. Practice reads `me/`.
- [ ] **Step 4:** Full gate. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(library): the learner model in me/`.

---

## PR 7: UI

### Task 12: Graph overlay, detail card and practice suggestions

**Files:**
- Create: `app/api/learner/route.ts` (GET → `LearnerSnapshot`).
- Modify: the graph render settings (`showKnowledge: boolean`, default true, in `src/core/contracts/graph.ts` render settings and the sanitizer), the graph canvas node colouring component, the node detail card (last evidence lines + "next review"), and the practice picker ("Suggested: shaky and due" group from the snapshot).
- Test: render tests (`renderToStaticMarkup`) for the detail card and the picker group; a settings sanitizer test for `showKnowledge`.

**Interfaces:**
- Colours are mapped in one place (`src/core/learner-colors.ts`, browser-safe): shaky, learning, solid, due, not-yet-checked. They use the existing graph palette tokens; `due` is shown as a ring on top of the state colour.

- [ ] **Step 1: Write the failing tests.**
  - `showKnowledge defaults on and sanitizes`: `sanitizeRenderSettings({})` → `showKnowledge: true`; `"no"` → `true`.
  - The detail card for a shaky concept contains its last evidence note and "next review".
  - The picker renders a "Suggested: shaky and due" group listing exactly the shaky and due concepts.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full gate. Then puppeteer screenshots at 390×844 and desktop width of the graph with the overlay and of the practice picker.
- [ ] **Step 5:** Commit: `feat(ui): show the learner's knowledge on the graph and in practice`.
- [ ] **Step 6:** Release, deploy, and verify on VM 104: after one real quiz session the concept's colour changes and `me/overview.md` in the export counts it.
