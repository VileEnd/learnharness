# Design: an OKF library + a learner model that points into it

Status: for owner approval (2026-10-25). Two projects, designed together, built in order (library first).

## Intent

The learner hopes the agents will **reference the material he has to learn much better**, because it is better structured. Today the teacher gets a flat search hit list and the graph's names. It has no table of contents to navigate (topic → document → section → concept, with links), and no memory of how well he knows anything.

The owner's model, in his words, is two things:
- **Reference library:** "the student's referenced data", meaning his documents and what was extracted from them.
- **Knowledge model:** "what the student knows and how good his knowledge is".

They must integrate: the learner model points into the library. The aim is a **sharper** teacher, not a softer one: probe where he slipped, skip what he has proven, bring back what is fading.

## Findings this design rests on

- **No JSON reaches a model.** Every tool renders plain text, and `read_document` already returns markdown. So OKF's value here is **navigation and linking**, not token savings on the storage format.
- **The graph today:**
  - 2,749 propositions (`nodes.jsonl`);
  - 2,286 reasoning chains (`chains.jsonl`);
  - 3,979 topic rows (`topics.jsonl`, document concepts only; `topics` is "DOCUMENT PATH ONLY" in `contracts/graph.ts`);
  - 35 documents.
- **The upstream author's principles:**
  - the graph is objective, world-facing facts;
  - no "marking things done";
  - learner state is derived from evidence and recomputed on read, never stored as a score;
  - *"Personalization compounds across sessions"*, with the state model left as *"redesign pending ideation"*.

  This design is that state model.
- **Evidence today:**
  - Practice: `problem.target` (graph ids) + `conclude.outcome` (`solved | solvedWithHints | movedOn | surrendered`) + `conclude.verdict` (text).
  - Teacher `quiz`: `type` is `predict | check`, plus a plan-tree `nodeId` (not a graph concept) and a client-graded result (option picked, stated confidence, note).
  - Free recall (`explain`/`recall`; replaces `quiz`/`probe` when `tools.explain` is on): graded **only in the agent's prose**, with nothing structured stored.
  - Probe questions: untagged.
- **Security.** The file tools (`ls`/`find`/`grep`/`read`, `src/agent/tools/fs-shared.ts`) and the `pdf` job (`pdfInputSchema.path`, `runPdfReaderAgent`) accept absolute paths against `os.homedir()`. `/data/auth.json` (the BYOK keys) is readable in the container.
- **OKF.** The maintained spec is **v0.2** (`GoogleCloudPlatform/open-knowledge-format`, `SPEC.md`):
  - `index.md` and `log.md` are reserved at every level, and `index.md` is a plain directory listing **without frontmatter** (the root may carry `okf_version`);
  - concept files need `type`;
  - provenance goes in a `sources` frontmatter list (`resource` required: URL or bundle-relative path; optional `id`, `title`), with per-claim footnotes keyed by `sources[].id`;
  - `generated: {by, at}` records how content was produced;
  - `stale_after` marks content stale from an instant on.

## Goals

1. A **generated OKF v0.2 bundle** of the library (documents, sections, concepts, chains, topics). Agents navigate it with rooted file tools and cite from it; the learner can download it.
2. **Search (RAG) used actively** for "where is X?". Hits name bundle paths, which the agent then reads.
3. A **learner model** derived from evidence: per concept, what he has shown, when, and what is due. It is rendered into the same bundle under `me/`, linking into the library.
4. **Prober, teacher and practice use both**: the library for content and citations, the learner model for where to probe, what to skip and what to revisit.
5. The graph home page can **show his knowledge** (a state overlay).
6. The agents can **no longer read files outside the bundle**.

## Non-goals

- OKF as the stored source of truth. The JSONL ledgers stay, and the bundle is a derived view (owner).
- Hand edits in the bundle flowing back (a possible later step).
- Gamification (points, streaks, percentages).
- Auditor or merger identity semantics. The only extraction changes are the two listed in Part 2: topics on session concepts, and attribution.

## Anti-goals (failure even if it "works")

- A stored score, or a concept marked known because it was *taught*.
- A teacher reciting the library instead of teaching from his current state.
- A bundle out of sync with the data, or `me/` presenting stale state as current.
- Any agent able to read secrets or files outside the bundle.

## Constraints

- **Laws:** import law and layers; ports and adapters; sole writers; the persisted record is the only source of truth; LLMs judge, code mechanizes; deterministic tests; fixture law (golden fixtures regenerate in the same commit as any on-disk format change).
- **Deployment:** browser-only self-hosted, BYOK, one household data set.
- **Embeddings:** the batch path may take up to ~10 hours (owner: acceptable). Nothing blocks on it.

---

## Part 1: the library as an OKF v0.2 bundle

### Layout (`data/okf/`, a regenerable cache)

```
index.md                            listing only; root carries okf_version: "0.2". Sections: Topics, Documents,
                                     "Your knowledge" (→ me/), "How to navigate"
log.md                              date-grouped, newest first: imports, extraction runs, re-describes (capped)
topics/index.md                     listing of all topics
topics/<topic>.md                   type: Topic — summary, its documents (with section outlines) and its
                                     concepts grouped by document section / teaching session
documents/index.md                  listing
documents/<doc>.md                  type: Document — title, summary, tags=topics, pages, filenames as aliases,
                                     outline linking the section files
documents/<doc>/index.md            listing of the sections
documents/<doc>/<section>.md        type: Section — full section text with page markers; "Concepts from
                                     this section"; sources → the document
concepts/index.md                   listing (grouped by topic)
concepts/<concept>.md               type: Proposition (below)
me/…                                Part 2
```

Concept file:
```markdown
---
type: Proposition
title: "P/V operations are atomic"                      # node.name
description: "The operations P and V …"                 # node.statement
tags: [Semaphoren, Wechselseitiger Ausschluss]
id: n_6ed41cea2113                                      # producer-defined
generated: { by: learnharness/extraction, at: 2026-10-24T21:24:03Z }
sources:
  - id: blatt4-s2
    resource: ../documents/blatt-04-kritische-abschnitte-ab12cd/s2-semaphores.md
    title: "Blatt 4 · §2 Semaphores · p. 3"
  - id: chat-semaphores
    resource: learnharness:chat/c_8f2a91            # the teaching session (app URI, opens in the app)
    title: "Teaching session 'Semaphores', 2026-10-20"
---
The operations P and V …[^blatt4-s2]

## Follows from
- [Critical section](critical-section-1a2b3c.md) + [Indivisible instructions](indivisible-instructions-4d5e6f.md)
## Leads to
- [Mutual exclusion with semaphores](mutual-exclusion-with-semaphores-9f8e7d.md)
## Also phrased as
- …aliases
```

- **Paths.** Kebab-case title + short id suffix. Names are fixed at creation, so paths are stable.
- **Chains.** One "Follows from" bullet per chain whose conclusion this node is; "Leads to" is the reverse.
- **Tolerance.** Unknown keys are tolerated, as the spec requires.
- **Conformance test.** It checks: `type` on every non-reserved file, no frontmatter in `index.md` except the root `okf_version`, ISO date headings in `log.md`, every relative link and every bundle-relative `sources[].resource` resolving (`learnharness:` URIs and URLs are external). Types are our own (`Topic`, `Document`, `Section`, `Proposition`, `Learner Model`, `Learner Topic`): v0.2 deliberately defines no type taxonomy.
- **Writing it:** a small deterministic frontmatter writer in `core/okf.ts` (no YAML dependency); the zip export uses `node:zlib` (no new dependency).

### Generation (sole writer)

- **Location:** `path.join(PATHS.data, "okf")` (`config.ts`), so Docker (`LH_DATA_DIR=/data/data`) and isolated test dirs work; never repo-relative.

- **Writer.** A new port `OkfBundleStore` (`src/core/ports.ts`) with an fs adapter, the only writer of `data/okf/`.
- **Rendering** is pure, in `src/core/okf.ts` (graph + documents + learner state → `{path, content}[]`). Composition lives in `src/server/okf.ts`.
- **Triggers** (debounced, single-flight):
  - merger commits, and every direct ledger rewrite (node delete, chain-table bulk delete, chat delete);
  - document import / replace / delete / redescribe;
  - topic-alias changes;
  - new evidence (Part 2: `me/` only);
  - a **daily rebuild of `me/`**, because "due" changes with the clock;
  - settings changes that affect gates;
  - on boot, when the bundle is missing or older than the data. Never on store construction and never under `NODE_ENV=test` (golden fixtures stay byte-identical; same pattern as `autoTick`).
- **Atomic rebuild.** Build into a temp dir, then rename. Full rebuilds are fine first.

### How the agents use it

- **Rooted file tools.** `ls`/`find`/`grep`/`read` become per-turn factories (`createLibraryTools({ root })`) that resolve only inside the library: relative paths only, `..` and absolute paths refused, `fs.realpath` containment against symlinks. Root = `LH_LIBRARY_DIR`, default `PATHS.data/okf`, in every environment.
- **The `pdf` job is removed** from the chat agents (owner-facing reason: in the self-hosted app it can't reach his PC's files anyway; PDFs arrive by upload → OCR → documents). Deprecated paths are deleted, not parked.
- **Prompts.** `30-learner-files.md` is rewritten: "His material and his knowledge live in the library: start at `index.md`, open the topic, follow links, read the section, cite 'title, p.N'; check `me/` for what he knows."
- **Gates.** The gates are global settings, so the generator renders the bundle **with them applied**: `agent.documentTools` off → no `documents/` and no section links; graph off (`graph.enabled` / `agent.graphTools`) → no `concepts/`, no `me/`, and no concept names or counts anywhere else. A gate change triggers a rebuild, so nothing leaks through cross-links.
- **Search.** `search_documents` stays the one search tool; hits become a union `kind: "section" | "concept"`, each with its bundle `path` (`DocumentSearchHit`, the tool details and `DocumentCard` follow). Concepts join the index as retrieval units: keyword immediately, embeddings via the batch path, **persisted outside the bundle** (`data/graph/concept-vectors.*`, keyed by node id + statement hash + model) so rebuilds never re-embed.
- **Retired:** `read_document` and `list_documents` (the bundle's `read`/`ls` replace them) and the prober's `list_sessions`/`list_propositions` (their "names only" description contradicts the new access). The auditor's own graph tools are separate and stay.
- **Who reads what.** Prober, teacher and practice all read the **full library**. The owner reversed the upstream "names only" ruling for the prober, so it may read concept statements and chains. Practice's picked-propositions block stays.
- **No context injection** (the upstream ruling stands), except one prompt line naming `index.md`.

### Export

`GET /api/okf/export` returns a zip of the bundle (behind the existing auth), via a "Download as OKF" button on `/documents`.

---

## Part 2: the learner model

### Evidence

An evidence event is `{at, conceptId, kind, outcome, chatId, toolCallId, note?}`. It is **derived at read time** from chat records plus one new ledger, and cached against their versions.

| Source | Concept link | Outcome | Counts? |
|---|---|---|---|
| practice `problem` + `conclude` | `problem.target`: **every** target gets the outcome | solved / solvedWithHints / movedOn / surrendered (+ verdict as note) | yes |
| teacher `quiz` `type: check` | new optional `concepts: string[]` | correct / miss / don't know (+ his note) | yes |
| prober `probe` | new optional `concepts` | correct / miss / don't know | yes |
| free recall `explain` `type: check` / `recall` (teacher + prober) | the call's `concepts` | **agent-recorded grade** (owner): correct / partly / wrong / don't know + one short note | yes |
| `quiz` or `explain` with `type: predict` | — | — | **no**: posed before teaching, misses expected (legacy records without `type` count as `check`) |
| dismissed questions, `conclude: dismissed` | — | — | **no** |

- **Confidence.** A correct answer with stated confidence **≤ 30** (active doubt on the slider) counts as **tentative**. The untouched default 50 and above count as a clean success, for `quiz` and `probe` alike.

- **Validation.** `concepts` is additive and optional, validated at call time like `nodeId`/`target` (unknown id → error-back). Agents take ids from concept files they read.
- **Free-recall grade.** The agent records it with a small `grade` tool when it judges a free answer. It references the explain/recall call id, uses the closed scale above plus a note, and is validated: one grade per call. It is a stored judgment, living in the chat record as a tool part.
- **New material (owner: link after extraction).** Questions about concepts born in the same session can't be tagged at ask time. Extraction fires when the teaching prose is written, so usually **before** he answers, and prober items sit outside teacher-prose batches. So attribution works per chat, not per batch:
  - **Input:** all graded, untagged, not-yet-attributed items of the chat (question + his answer + grade) × all propositions with provenance in that chat (born or linked).
  - **Output:** `{toolCallId → conceptIds[]}` (0..3 each). An **explicit empty result is stored too**, so an off-map item is never sent again.
  - **Triggers:** after each merge for that chat, and when an answer or `grade` lands in a chat that already has propositions (debounced). Serial per chat.
  - Stored append-only in `data/learner/attributions.jsonl` through a new `LearnerStore` port. The attribution stage is the sole writer.
  - Code validates that ids exist. A failed attribution checkpoints nothing and never touches the turn.

### Topics for every concept (owner)

The session extraction path gets the same `topics` field as the document path:
- the extractor proposes topics per proposition;
- they are canonicalised onto existing topics through the existing alias machinery;
- the merger appends the `topics.jsonl` rows.

So session-born concepts appear under topics in `topics/` and `me/`. `contracts/graph.ts`'s "DOCUMENT PATH ONLY" note and the extraction prompt change accordingly.
- **Canonicalisation before the merge.** The batch's proposed topics go through `topicist.canonicalize` + `writeTopicAliases` **before** `mergeFindings`, inside the per-source serial discipline plus a global lock around the alias file, so the merger stays pure and concurrent extractions can't clobber aliases.
- **Existing session concepts** get topics through a one-off pass. It needs **open-ended** tagging (1–3 topics per node, new topics allowed), because the "adopt" seam's `tagNodes` only accepts an existing topic list. Then canonicalise and append via `mergeTopicRows`. It runs once from an explicit admin action or boot migration, never in tests.

### Derived state (computed on read; thresholds are settings)

Per concept, from its evidence in time order:
Evidence is grouped per session; within a session, the **last** item decides that session's result (clean, weak = tentative/solvedWithHints/partly, or failed = miss/don't know/wrong/surrendered/movedOn). The **streak** is the number of consecutive clean session results since the last weak or failed one.
- **not yet checked:** no evidence. This covers all concepts he has only read about.
- **shaky:** the latest session result is weak or failed.
- **learning:** the latest result is clean, but the streak is 1 (first success, or first success since a slip). Next check after 3 days.
- **solid:** a streak of at least 2 clean sessions.
- **due for review** (owner: growing intervals): learning or solid, and its interval has passed since the last clean session.
  - Interval by streak: **1 → 3 days, 2 → 7, 3 → 21, 4+ → 60**.
  - Any weak or failed result resets the streak to 0 (shaky). The next clean session starts again at learning with 3 days. Hints and tentative reset just like a miss, but the evidence line says which.
  - Rendered as `stale_after` on the learner page entries.
- **weak foundation** (a marker): one of the concept's premises (via chains) is shaky or due. One level deep in v1.

Nothing new is stored except the free-recall grades (chat tool parts) and the attributions (ledger).

### In the bundle (the integration)

`me/` sits beside the library and only **links into it**. Concept files stay objective, so a quiz never rewrites `concepts/`:

```
me/index.md               listing
me/overview.md            type: Learner Model — as-of date; per topic: solid / shaky / due / not yet checked
                           counts (plus learning); "due today"; "weakest foundations"
me/topics/<topic>.md      type: Learner Topic — concepts grouped by state, each linking ../../concepts/…,
                           with the last evidence lines ("missed 2026-10-20 in 'Semaphores': confused
                           P and V") and its next review date; stale_after = the earliest due date
```

### How the agents use it

- **Prober:** reads `me/topics/<topic>.md` first. It probes where he is shaky, due or on a weak foundation, and tags its questions with `concepts`.
- **Teacher:** builds on solid concepts without re-explaining them, revisits shaky and due ones, tags checks, and grades free recall with `grade`.
- **Practice:** the picker gets a "Suggested: shaky and due" group, and the practice agent reads `me/`.

### UI

- **Graph home page:** a "Show my knowledge" render toggle (default on) colours nodes by state, neutral otherwise. The detail card shows the last evidence lines and the next review date.
- **`/documents`:** the OKF download button.

---

## Adopted from Google's OKF reference (owner, 2026-10-25)

Source: `GoogleCloudPlatform/open-knowledge-format` (Apache-2.0), formerly `knowledge-catalog/okf`.

- **Index format** (always). Every `index.md` follows the reference generator: one `# <Type>` section per type, sorted, with entries `* [Title](link) - description`; subdirectories are listed under `# Subdirectories`.
- **Trust and lifecycle fields on concepts:**
  - `verified: [{ by: learnharness/auditor, at }]`, one entry per additional distinct source the auditor linked to the node. This means corroborated by an independent source; the auditor no longer fact-checks content.
  - `status: stable`, or `status: deprecated` when none of the node's provenance sources exists any more (deleted document or chat).
  - Agents are told that unverified means "one source", and that deprecated concepts are history.
- **Misconceptions as OKF `not:` entries** (`term`, `why`, `instead`). They live on the learner side only, so concept files stay objective. Each concept with evidence gets `me/concepts/<concept>.md` (`type: Learner Concept`) with its evidence history and a `not:` list of his **open** misconceptions.
  - **Sources:** a quiz/probe miss gives term = the option he picked, instead = the correct option, why = his note if any. `grade` gains optional `misconception: { term, instead, why? }` for free answers. Practice verdicts don't state the correction, so they give term only.
  - **Lifecycle:** a misconception closes when the concept's next session result is clean (it stays in the history, not in `not:`).
  - The prober and teacher read `not:` and target exactly that confusion. `me/topics/<topic>.md` links to these pages.
- **Graph viewer in the download.** The export zip includes `viz.html`, a TypeScript port of the reference `viewer/generator.py` plus its `viz.html` template, `viz.js` and `viz.css`, vendored with the Apache-2.0 notice. It loads cytoscape and marked from jsDelivr as upstream does, so it needs internet when opened. It is generated only for the export, not for the agents' bundle.

## Build order (one PR each: Sonnet implements in a worktree, Opus reviews and verifies on VM 104 with real data)

1. **Rooted tools.** Factories rooted at `LH_LIBRARY_DIR` for `ls/find/grep/read` (realpath containment); the `pdf` job removed (security, standalone).
2. **Bundle generator.** `OkfBundleStore`, `core/okf.ts`, triggers, atomic rebuild, export, conformance test.
3. **Agents on the library.** Prompt rewrite, gate filtering, search hits with bundle paths, concepts as search units, prober full access.
4. **Topics for all concepts.** Session-extraction `topics`, prompt and contract change, one-off tagging of existing session concepts.
5. **Evidence.** `concepts` on quiz/probe/explain/recall, the `grade` tool, evidence derivation, the attribution step + `LearnerStore`.
6. **Learner state + `me/`.** Derivation incl. intervals and weak foundations, `me/` rendering + daily rebuild, prober/teacher/practice prompt use.
7. **UI.** Graph overlay, detail-card evidence, practice suggestions.

Each PR passes typecheck, tests, lint and build, plus golden fixtures where the on-disk format changes.

## My calls (owner, please check)

- **OKF v0.2 layout:** topic/document pages are files beside their folders, because `index.md` is listing-only.
- **Predictions don't count** (`quiz` and `explain` alike), and dismissals don't count. A correct answer at confidence ≤ 30 is tentative; the default 50 counts as clean. A surrendered problem counts against all its targets.
- **A fifth state, "learning":** one clean session (first success or first since a slip), due after 3 days. Without it, a single success fit no state (review finding).
- **Free recall is graded via a `grade` tool** (a tool part in the chat record), not a hidden field.
- **Daily `me/` rebuild**, plus `stale_after`, so "due" is never stale.
- **Rooting covers dev runs too**; the `pdf` job is removed; `read_document`, `list_documents` and the prober's `list_sessions`/`list_propositions` are retired in favour of the bundle.
- **Settings gates are applied when the bundle is generated** (they're global), so nothing leaks via cross-links.
- **Session provenance** uses `learnharness:chat/<id>` URIs in `sources`.
- **Kept:** practice's picked-propositions block.
- **Export is the full bundle:** `GET /api/okf/export` renders on demand with only `graph.enabled` and document presence applied (the agent gates are about agents, not his download); `data/okf/` itself stays agent-gated.
- **Thresholds start as named constants in core** (confidence ≤ 30, intervals 3/7/21/60, same-day gap below); they move into settings only after tuning on real data.
- **`grade` shows as a quiet chip** in the chat ("counted as: partly"), so he can see how an answer counted. An answered explain/recall without a `grade` produces no evidence. `grade` stays registered while an ungraded item is pending, even if `tools.explain` was switched off.
- **Session order and spacing:** a concept's session results are ordered by that session's last evidence timestamp on the concept. A clean session advances the streak only if it is **at least 20 hours** after the previous counted clean session; sooner, it just confirms the current state (spacing is the point). `stale_after` is a full UTC instant (`YYYY-MM-DDTHH:mm:ssZ`), omitted when a topic has no learning/solid concept.

## Compatibility and builder notes

- **Old transcripts must keep rendering.** Golden fixtures (`chats/chat_mv27rrra_feff23b6.json`, `jobs/job_mv28tfii_2a54290a.json`) and real VM chats contain `pdf`, `read_document`, `list_documents`, `list_sessions` and `list_propositions` parts.
  - **Remove** the retired tools from the agent registries, `runner.ts` dispatch, `TOGGLEABLE_TOOLS` (`core/pending.ts`), the settings toggles and `SLOT_META.vision` (`components/settings/agent-section.tsx`) and the `pdfReader` model role (`config.ts`).
  - **Keep** read-side tolerance: `JobKind` `"pdf"`, the artifact card mappings (`PdfJobCard`, `DocumentCard`, `ToolCallCard`) and `ACTIVITY_LABELS`.
- **Delete `subagents/pdf-reader.ts`, keep `subagents/pdf-ops.ts`.** The researcher's sandboxed `pdf-read.ts` and `headless.ts` import it.
- **Staging.** PR 1 roots the tools before the bundle exists. A missing root returns a clean "the library is empty" result; no `realpath` on a missing root and no `mkdir` on read (golden byte-identity). **PRs 1–3 deploy together** on VM 104, so live agents never see the old prompt against an empty root.
- **Stable references.**
  - Document and topic paths can change (`redescribe` renames titles, aliases merge topics). Search hits and tool details keep `docId` / `sectionId` / `conceptId` beside `path`, so `DocumentCard` links in saved transcripts never rot.
  - Topic slugs get a short hash suffix (`c-plus-plus-3fa1`), because "C++" and "C#" would collide.
- **Untagged bucket.** Concepts with no topic (before the one-off pass, or when extraction yields none) are listed under "Untagged" in `concepts/index.md`, `topics/` and `me/`, so they stay reachable.

## Left to the builder

The slug algorithm; debounce timings; the `log.md` cap; incremental rebuild; rendering of chains with many premises; zip streaming; overlay colours (in the existing graph style); the exact prompt wording (goal-first, field names verbatim).
