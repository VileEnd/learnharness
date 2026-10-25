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
    resource: "Teaching session 'Semaphores', 2026-10-20"   # scope descriptor, not followable
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
- **Conformance test.** It checks: `type` on every non-reserved file, no frontmatter in `index.md` except the root `okf_version`, ISO date headings in `log.md`, every relative link and every `sources[].resource` path resolving.

### Generation (sole writer)

- **Writer.** A new port `OkfBundleStore` (`src/core/ports.ts`) with an fs adapter, the only writer of `data/okf/`.
- **Rendering** is pure, in `src/core/okf.ts` (graph + documents + learner state → `{path, content}[]`). Composition lives in `src/server/okf.ts`.
- **Triggers** (debounced, single-flight):
  - merger commits;
  - document import / replace / delete / redescribe;
  - topic-alias changes;
  - new evidence (Part 2: `me/` only);
  - a **daily rebuild of `me/`**, because "due" changes with the clock;
  - on boot, when the bundle is missing or older than the data.
- **Atomic rebuild.** Build into a temp dir, then rename. Full rebuilds are fine first.

### How the agents use it

- **Rooted file tools.** `ls`/`find`/`grep`/`read` **and the `pdf` job** resolve only inside the library root. Absolute paths and `..` escapes are refused. The root comes from `LH_LIBRARY_DIR` and defaults to `data/okf/` in every environment (dev included). This ends the "find files in his home directory" capability by design.
- **Prompts.** `30-learner-files.md` is rewritten: "His material and his knowledge live in the library: start at `index.md`, open the topic, follow links, read the section, cite 'title, p.N'; check `me/` for what he knows."
- **Gates.** The bundle obeys the existing settings: `agent.documentTools` off hides `documents/`; graph off (`graph.enabled` / `agent.graphTools`) hides `concepts/`, `topics/`' concept lists and `me/`. This is done by filtering at the tool root, not by separate bundles.
- **Search.** `search_documents` hits also give the section's bundle path. Concept files join the index as retrieval units: keyword search immediately, embeddings via the batch path.
- **Who reads what.** Prober, teacher and practice all read the **full library**. The owner reversed the upstream "names only" ruling for the prober, so it may read concept statements and chains. `list_sessions` / `list_propositions` (the auditor needs them) and practice's picked-propositions block stay. Prompts point to the bundle for everything else.
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
| teacher `quiz` `type: check` | new optional `concepts: string[]` | correct / miss / don't know (+ his note) | yes; a correct answer with low stated confidence counts as **tentative**, not a clean success |
| teacher `quiz` `type: predict` | — | — | **no**: predictions are posed before teaching, and misses are expected |
| prober `probe` | new optional `concepts` | correct / miss / don't know | yes |
| free recall `explain` / `recall` (teacher + prober) | the call's `concepts` | **agent-recorded grade** (owner): correct / partly / wrong / don't know + one short note | yes |

- **Validation.** `concepts` is additive and optional, validated at call time like `nodeId`/`target` (unknown id → error-back). Agents take ids from concept files they read.
- **Free-recall grade.** The agent records it with a small `grade` tool when it judges a free answer. It references the explain/recall call id, uses the closed scale above plus a note, and is validated: one grade per call. It is a stored judgment, living in the chat record as a tool part.
- **New material (owner: link after extraction).** Questions about concepts born in the same session can't be tagged at ask time. After a session batch is merged, a **cheap-slot attribution step** sees the batch's graded, untagged check/probe/recall items (question + his answer) and the batch's newly born and linked propositions, and returns `{toolCallId → conceptIds[]}`.
  - Stored append-only in `data/learner/attributions.jsonl` through a new `LearnerStore` port. The attribution stage is the sole writer.
  - Code validates that ids exist. A failed attribution checkpoints nothing and never touches the turn.

### Topics for every concept (owner)

The session extraction path gets the same `topics` field as the document path:
- the extractor proposes topics per proposition;
- they are canonicalised onto existing topics through the existing alias machinery;
- the merger appends the `topics.jsonl` rows.

So session-born concepts appear under topics in `topics/` and `me/`. `contracts/graph.ts`'s "DOCUMENT PATH ONLY" note and the extraction prompt change accordingly. Existing session concepts get topics through a one-off tagging pass, reusing the "adopt" tagging seam (cheap slot, rows through the merger).

### Derived state (computed on read; thresholds are settings)

Per concept, from its evidence in time order:
- **not yet checked:** no evidence. This covers all concepts he has only read about.
- **shaky:** the latest evidence is a miss, don't know, partly, surrendered or movedOn; or solvedWithHints / tentative with no clean success since.
- **solid:** the latest evidence is a clean success (correct, solved), with at least 2 clean successes in at least 2 sessions.
- **due for review** (owner: growing intervals): solid, but the interval since the last clean success has passed.
  - Intervals: **3 → 7 → 21 → 60 days**, stepping up with each further clean success in a new session.
  - A miss resets to shaky, and the next solid restarts at 3 days.
  - Rendered as `stale_after` on the learner page entries.
- **weak foundation** (a marker): one of the concept's premises (via chains) is shaky or due. One level deep in v1.

Nothing new is stored except the free-recall grades (chat tool parts) and the attributions (ledger).

### In the bundle (the integration)

`me/` sits beside the library and only **links into it**. Concept files stay objective, so a quiz never rewrites `concepts/`:

```
me/index.md               listing
me/overview.md            type: Learner Model — as-of date; per topic: solid / shaky / due / not yet checked
                           counts; "due today"; "weakest foundations"
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

## Build order (one PR each: Sonnet implements in a worktree, Opus reviews and verifies on VM 104 with real data)

1. **Rooted tools.** `LH_LIBRARY_DIR` root for `ls/find/grep/read/pdf`; escapes refused (security, standalone).
2. **Bundle generator.** `OkfBundleStore`, `core/okf.ts`, triggers, atomic rebuild, export, conformance test.
3. **Agents on the library.** Prompt rewrite, gate filtering, search hits with bundle paths, concepts as search units, prober full access.
4. **Topics for all concepts.** Session-extraction `topics`, prompt and contract change, one-off tagging of existing session concepts.
5. **Evidence.** `concepts` on quiz/probe/explain/recall, the `grade` tool, evidence derivation, the attribution step + `LearnerStore`.
6. **Learner state + `me/`.** Derivation incl. intervals and weak foundations, `me/` rendering + daily rebuild, prober/teacher/practice prompt use.
7. **UI.** Graph overlay, detail-card evidence, practice suggestions.

Each PR passes typecheck, tests, lint and build, plus golden fixtures where the on-disk format changes.

## My calls (owner, please check)

- **OKF v0.2 layout:** topic/document pages are files beside their folders, because `index.md` is listing-only.
- **Predictions don't count.** A low-confidence correct answer counts as tentative. A surrendered problem counts against all its targets.
- **Free recall is graded via a `grade` tool** (a tool part in the chat record), not a hidden field.
- **Daily `me/` rebuild**, plus `stale_after`, so "due" is never stale.
- **Rooting covers dev runs too**, and the pdf job is rooted as well. The home-directory search ability is removed.
- **Settings gates filter** the bundle per agent.
- **Kept:** the prober's `list_sessions`/`list_propositions` and practice's picked list stay.

## Left to the builder

The slug algorithm; debounce timings; the `log.md` cap; incremental rebuild; rendering of chains with many premises; zip streaming; overlay colours (in the existing graph style); the exact prompt wording (goal-first, field names verbatim).
