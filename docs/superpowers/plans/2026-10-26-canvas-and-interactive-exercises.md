# Canvas Workspace and Interactive Exercises Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agents pose browser-graded structured exercises (13 formats, shipped in waves) and multi-turn hand-drawn canvas tasks that the agent reads, grades and marks up with teacher ink, in probe, teach and practice sessions. The point is to make learning generative and appropriately hard: you produce answers rather than recognise them, get hints on a ladder instead of answers, and the agent picks the instrument and the difficulty from your learner model, following the research basis in PR 0.

**Architecture:**
- **Pure core.** The math-expression engine, the exercise schemas and their graders, and the drawing scene contract (validation, bounding box, region grid, structured text, content-hash ids) all live in `src/core`. Annotations are derived from `annotate` tool calls in the chat record and are never stored on their own.
- **Store.** A `DrawingStore` adapter owns `data/drawings/<chatId>/`. It holds submitted PNG + scene pairs, pasted-image assets, server drafts and cached vision transcripts.
- **Agents.** The new tools are `exercise`/`assess` (client-answered question tools, like `quiz`), `work`/`sketch` (multi-turn poses like practice `problem`, closed by `grade`) and `annotate`. Drawings reach the model through an injected resolver in `toLlmMessages`. The model gets image content while the task is open and a text stub once it is closed. A `transcriber` role on the `vision` slot covers text-only conversation models.
- **Client.** Our own Canvas2D engine built on `perfect-freehand`, one widget per format, and a `WorkDock` that mirrors `PracticeDock`.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Next.js 16 (read `node_modules/next/dist/docs/` before writing route or config code), pi-ai / pi-agent-core with TypeBox tool schemas, React, node:test via tsx, `perfect-freehand@1.2.3`, KaTeX 0.18.2 (already a dependency). PR 5 adds `pyodide`, `@yowasp/clang` and `@bjorn3/browser_wasi_shim` as vendored static runtimes.

**Spec:** The source proposal is `/home/test/.gemini/antigravity-cli/brain/2444bbca-957a-4703-b437-398bcd15ab37/implementation_plan.md`. This plan supersedes it wherever they differ. The **Decisions** section below records the owner's rulings from 2026-10-26.

## Decisions (owner, 2026-10-26)

1. **Scope.** Everything ships as ordered PRs, and each PR must be able to ship alone:
   - PR 0: the learning doctrine and the Mixed quizzing mechanic (prompts and settings only)
   - PR 1: generative core formats, with hints, retries and required thinking
   - PR 2: canvas + `work`/`sketch`
   - PR 3: annotations
   - PR 4: the remaining formats
   - PR 5: `code`
2. **Formats.**
   - PR 1 ships the generative set: `numeric`, `blanks` (no word bank), `table`, `multipart`.
   - PR 4 ships `ordering`, `matching`, `spot-error`, `fields`, `sequence`, `plot`, `label` and `graph`.
   - PR 5 ships `code`.
3. **Defaults.**
   - Every format defaults **on** (absent key = enabled).
   - The session Canvas toggle defaults **off**.
   - The quizzing mechanic defaults to **Mixed** (decision 19).
   - The doctrine ships **first** (PR 0). Its prompt wording is shown to the owner before it is committed.
4. **Ink anchoring.** The exported PNG carries a labelled region grid, and typed objects carry short ids. Each `annotate` mark targets an object id, a grid cell or a cell range. Raw pixel coordinates are not used.
5. **Code runtimes** are self-hosted in the image (vendored into `public/runtimes/` at build), not loaded from a CDN.
6. **Text-only conversation models.** A new `transcriber` role, mapped to the `vision` slot, transcribes each submitted drawing once. The transcript is cached per drawing id.
7. **Storage** is `data/drawings/<chatId>/`. `drawingId` is a content hash of the scene. Annotations are derived from the record and are never written here.
8. **Drafts** are server-side: the working scene autosaves (debounced) to `data/drawings/<chatId>/drafts/<callId>.json`.
9. **Engine.** Our own Canvas2D engine on `perfect-freehand`; no Excalidraw or tldraw.
10. **Task model.** `work`/`sketch` are multi-turn and coached: submit, coach or annotate, revise, until `grade` closes the task.
11. **Surface.** The canvas opens as a session-area overlay, under the same rule as the diagram and plan focus: mounted inside the session area, top bar and sidebar visible, never `fixed inset-0`.
12. **One lane.** While a canvas task is open, everything the learner sends is a submission (text and/or drawing), as in practice. Dictation (voice to text) feeds the "Your thinking" field, as in every other dock.
13. **Tablet and desktop only.**
    - A device is canvas-capable when `Math.min(screen.width, screen.height) >= 600` (the physical screen, not the viewport, so iPad split view still counts).
    - On a phone, the Canvas pill and every "Open canvas" button are hidden.
    - On a phone the turn runs without the canvas tools, so the agent falls back to quiz, explain or exercise questions.
    - A canvas task that is already open shows a free-text answer field on a phone.
    - Server-initiated turns (job wakes) count as not canvas-capable.
14. **Confidence.** Structured exercises carry the quiz confidence rail. A correct answer at confidence of at most 30 is tentative (weak), as for quiz.
15. **Practice "Check"** shows per-item ✓/✗ marks right away, but never the expected values. Expected values appear only at `conclude`.
16. **Input on the tablet.** Once a pen pointer has been seen on the page, only the pen draws and one finger pans; before that, one finger draws and two fingers pan and zoom. The eraser removes whole strokes or objects.
17. **No learner-initiated canvas.** The canvas opens only for an agent-posed `work`/`sketch` or a `problem` with `canvas: true`.
18. **Side questions allowed.** While a canvas task is open the agent may still pose quiz, explain, exercise or ask questions. The question dock takes priority until the question is answered, then the work dock returns. Only a second canvas task is refused.
19. **Mixed quizzing mechanic (new default).**
    - The setting becomes three-way: Mixed / Multiple choice / Free recall.
    - In Mixed, the agent holds both quiz and free recall (teach `quiz` + `explain`; probe `probe` + `recall`) plus `exercise`/`assess`, and picks per concept from the learner model:
      - new concept (no evidence): a short worked example or a prediction first, then a produced answer with immediate feedback;
      - shaky or due: free recall or a generative exercise;
      - solid: a harder composition or canvas task;
      - an open confusion (`not:` in `me/`): multiple choice whose distractors are built from that confusion, to discriminate it.
    - Records that explicitly chose multiple choice (`tools.explain === false`) or free recall (`tools.explain === true`) keep their choice; an absent key resolves to Mixed.
20. **Difficulty band.** Aim for about 85% success per retrieval event (already practice doctrine). Clean success steps difficulty up, success with hints holds it, a miss steps it down.
21. **Foundation first.** When answers show a real gap rather than a slip (`dontKnow`, hints at R4 or above, a give-up, or a structural miss), the agent stops pushing the struggle. It teaches the missing starting knowledge (worked example, then faded steps), then returns with a fresh-surface version of the task.
22. **Hints everywhere, on the R0–R5 ladder.**
    - Exercises carry a pre-written ladder: the agent commits 2–3 escalating `hints` with the answer key, and "Hint" reveals the next one instantly, with no extra turn.
    - Canvas tasks and practice problems get hints live: "Hint" sends a `hint` input and the agent answers with the next rung only.
    - The help used is recorded and lowers the evidence (decision 24).
23. **Retries until you give up (teach/probe exercises).**
    - "Check" grades locally and shows per-item ✓/✗ without the key; you may retry any number of times.
    - "Show answer" gives up and reveals the key.
    - Only the final result is submitted to the agent, together with `attempts`, `hintsUsed`, `gaveUp` and the first attempt's verdict and confidence.
24. **Evidence honours help** (guards against guess-and-check, the "help abuse" pattern):
    - correct on the first attempt with no hints: clean (tentative/weak when confidence is at most 30);
    - correct after retries or with any hint: weak (raw `"correctWithHelp"`);
    - gave up: failed (raw `"surrendered"`);
    - canvas tasks graded `correct` with rung R2 or above: weak.
25. **Required thinking, decided by the agent.** `quiz`, `explain`, `exercise`, `work` and their probe twins gain an optional `requireThinking: boolean`. When it is set, Submit stays disabled until "Your thinking" has text (typed or dictated). "I don't know" stays available without thinking.
26. **Feedback always follows an attempt** (the testing and generation effects depend on it). A high-confidence error gets an explicit correction, not just a mark (the hypercorrection effect).

### Defaults this plan chose (confirm or change when approving)

- **Tool schemas.** The tool schema carries `format` as a string enum of the enabled formats and `spec` as an open object. Per-format validity is enforced in `execute` by `exerciseSpecProblems`, which returns an `invalidInputResult` the model retries on. Deeply nested `anyOf` unions are avoided in tool schemas.
- **Scoring.**
  - `numeric` is all-or-nothing.
  - `blanks` scores per blank.
  - `table` scores per editable cell.
  - `multipart` takes the weighted sum of its parts.
  - PR 4: `ordering` scores per slot, `matching` per left item.
- **Outcome.** `correct` when `earned === total`; `partly` when `0 < earned < total`; `wrong` when `earned === 0`.
- **Region grid.** 8 columns `A`–`H`. Rows are numbered from `1`, with square cells, `rows = clamp(round(8 · h / w), 1, 16)`.
- **Pasted images** are stored as assets (`assets/<sha12>.<ext>`, at most 1600 px on the long side, downscaled in the client). The scene references them by `assetId`, never as data URLs.
- **Draft autosave** is debounced at 2 s. Drafts of closed tasks are kept, since they are small. A chat's whole `data/drawings/<chatId>/` folder is removed when the chat is deleted.
- **Export.** The PNG is capped at 2048 px on its long side, rendered at 2× scale, with a 32 world-unit padding.

## Global Constraints

- **Import law (lint-enforced).**
  - `app/` imports only the `@/src/core` and `@/src/server` barrels.
  - `components/` imports only `@/src/core`.
  - `src/agent` never imports server or store.
  - `src/core` imports nothing outside core.
  - Only `src/store` touches `data/`.
- **Browser-safe core barrel.** New core modules re-exported from `src/core/index.ts` (`math-expr.ts`, `exercise-core.ts`, `canvas-core.ts`) must not import `node:*`. Content hashing therefore uses a pure-JS SHA-256 in `canvas-core.ts` (`sha256Hex(bytes: Uint8Array): string`), not `node:crypto`.
- **Single source of truth.**
  - The chat record is the truth.
  - Annotations, active task, grade state and plan statuses are derived at read time.
  - The only non-record drawing files are content-addressed submissions, assets, drafts and transcript caches.
- **Deterministic ids.**
  - `drawingId = "drw_" + sha256Hex(canonicalJson(scene)).slice(0, 12)`
  - `assetId = "ast_" + sha256Hex(bytes).slice(0, 12)`
  - Grading shuffles use `seededRandom(toolCallId)`.
- **Side channels are contained.** A failed vision transcription never fails the turn. The model then gets `[Drawing <drawingId>: transcription unavailable]` plus the structured text.
- **Absent renders as absent.** A missing score or transcript shows nothing, never zero.
- **Old transcripts keep rendering.** Add only; never rename an existing tool, marker or `QuestionKind`.
- **Fixture law.** Every on-disk format change regenerates `tests/fixtures/golden-data/` by running the app (see its README), in the same PR:
  - PR 0: a record with the `quizMechanic` setting;
  - PR 1: a chat with answered `exercise` calls (one with retries, hints and a give-up);
  - PR 2: the markers `work-submission`, `work-dismissed` and `hint-request`.

  New marker customTypes are added to `EXPECTED` in `tests/golden-fixtures.test.ts`.
- **Docs.** Each PR updates `docs/architecture.md` (seam directory, ports, invariants) for what it adds. PR 0 adds a "Research basis" section to `docs/teaching-methodology.md`.
- **Prompts.** Tool field names cited in prompts must match the schemas verbatim. A `shared/` fragment may only cover tools both prober and teacher hold. Where the names differ (`exercise` vs `assess`, `work` vs `sketch`), say "the exercise tool" / "the canvas tool", as `20-question-tools.md` does for quiz.
- **Every PR gate.**
  - `npm run typecheck && npm test && npm run lint && npm run build`
  - then `node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs`
  - PR 5 also runs `docker build -t learnharness:local .`
- **Git.** Branch with `git fetch && git switch -c <branch> origin/main`. Commit trailers:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TV9Fpzt5T11xS6kno9Uh2h
  ```
- **Release.** After each PR merges, ship it per the release flow: merge, then redeploy VM 104 (`ssh root@learnharness.fritz.box systemctl restart learnharness-stack`), then bump, tag and publish.
- **Shell safety.** Never `pkill -f`; kill by PID. Use absolute paths for builds.
- **UI laws to keep:**
  - *The one-Esc law:* every surfaced layer claims Esc at the document level, so one Esc does one thing (see `components/session-overlay.tsx`).
  - `useBackDismiss` closes overlays on the back gesture.
  - `useEnterSubmits`: Enter submits from anywhere except typing surfaces. Exercise inputs and canvas text editors are typing surfaces.
  - `useDictationTarget`: the open dock's thinking field claims dictated text; the canvas workspace's field claims it while the workspace is open.

## Review Focus

1. **A model-switch PUT silently clears `canvas`.** `saveSettings` replaces the whole `ChatSettings` object. `ModelControl` PUTs `{model, thinkingLevel}`, so a naive change would drop `canvas` every time the learner changes model. Expected: canvas survives model and thinking changes, and vice versa. Test in Task 8: `settings PUT preserves canvas across a model change`.
2. **The learner submits the same scene twice, or reloads mid-task.** Expected: the same `drawingId` and no duplicate files on a resubmit, and the draft restored after a reload or a device switch. Tests in Task 8: `saveDrawing is idempotent by content` and `draft round-trips`.
3. **An ambiguous numeric answer** (`1/3` vs `0.333`, `2pi` vs `6.2832`, `1e-3`, a unicode minus `−5`, a trailing unit, a comma decimal `0,5`). Expected: the declared tolerance decides; a unicode minus and a comma decimal are normalised; a unit suffix is stripped only when it equals `spec.unit`. Tests in Task 1: `parseNumberLike normalises` and Task 2: `numeric honours tolerance`.
4. **An expression equivalence that hits a pole or NaN at a sample point** (`1/x` vs `x^-1`, `sqrt(x)` for negative samples). Expected: points where both sides are undefined are skipped; points where only one side is undefined count as a mismatch; fewer than 4 valid points means "not equivalent". Test in Task 1: `exprEquivalent skips shared poles`.
5. **A canvas task left open, then continued on a phone.** Expected:
   - the work dock shows the question and a free-text field ("Draw on a tablet or computer");
   - submissions still go through;
   - the agent poses no new canvas task during phone turns.

   Tests in Task 9 (`phone turn has no work tool but keeps grade`) and Task 12 (`WorkDock phone fallback`).
6. **A text-only conversation model with no `vision` slot configured, or a failing transcription call.** Expected: the turn still runs, and the model gets the stub plus the structured text, never a thrown error. Test in Task 10: `text-only without transcriber falls back to stub`.
7. **Guess-and-check through unlimited retries or hint spam.** Expected: anything other than a first-attempt, hint-free correct answer is at most weak evidence, and a give-up is failed. Tests in Task 4: `exerciseItem: correct after retries is weak` and `exerciseItem: give-up is surrendered`.
8. **A Mixed-mode learner who explicitly chose multiple choice before this release.** Expected: they stay on multiple choice, and only an absent setting becomes Mixed. Test in Task 0.1: `explicit choice survives the Mixed default`.

---

## PR 0: the learning doctrine and the Mixed mechanic

### Task 0.1: Mixed quizzing mechanic

**Files:**
- Modify: `src/core/settings.ts` (`AgentSettings.quizMechanic?: "mixed" | "choice" | "free"`; `sanitizeAgent` keeps only those three values)
- Modify: `src/core/settings-resolution.ts`:
  - `resolveQuizMechanic(agent?: AgentSettings): "mixed" | "choice" | "free"`, with the rule `quizMechanic ?? (tools.explain === true ? "free" : tools.explain === false ? "choice" : "mixed")`
  - `EffectiveSettings.agent.quizMechanic`
- Modify: `src/server/settings-body.ts` (`parseAgentSettingsBody` accepts `quizMechanic`; any other value → 400)
- Modify: `src/agent/tools.ts`:
  - `quizMechanics()` is replaced by the resolved mechanic, carried on the contexts as `quizMechanic`
  - Mixed registers both quiz-shaped and recall-shaped tools (teach `quiz` + `explain`; probe `probe` + `recall`)
  - `gradeFor` arms `grade` for `"free"` and `"mixed"`
- Modify: `src/server/chat-handler.ts` (pass `quizMechanic: effective.agent.quizMechanic`)
- Modify: `components/settings/agent-section.tsx` (the segmented control gains "Mixed" first; `composeQuizMechanics(agent, m)` writes `quizMechanic` and leaves `tools.explain` as stored)
- Modify: `src/agent/prompts/shared/20-question-tools.md` (in Mixed, both instruments exist; the mechanics text names both)
- Test: `tests/quiz-mechanic.test.ts`, plus `tests/question-tools.test.ts` additions

- [ ] **Step 1: Failing tests:**
  - `absent mechanic resolves to mixed`.
  - `explicit choice survives the Mixed default`: `{tools:{explain:false}}` resolves to `"choice"`.
  - `explain true resolves to free`.
  - `mixed registers quiz and explain for the teacher`, `mixed registers probe and recall for the prober`.
  - `grade armed in mixed`.
  - `parseAgentSettingsBody rejects an unknown mechanic`.
  - `segmented control renders Mixed first`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(settings): Mixed quizzing mechanic (default)`

### Task 0.2: Doctrine prompts and the research basis

**Files:**
- Modify: `src/agent/prompts/teacher/30-question-principles.md`, `teacher/20-teaching.md`, `prober/10-probe-doctrine.md`, `practice/10-doctrine.md` (practice only gains the foundation-first rule; its ladder and band already exist)
- Modify: `docs/teaching-methodology.md` (a "Research basis" section with one line per principle and its source)

**Content (the owner approves the wording before commit):**
- **Instrument choice by learner state (Mixed):**
  - new concept: worked example or prediction, then a produced answer;
  - shaky or due: free recall or a generative exercise;
  - solid: composition or a canvas task;
  - an open `not:` confusion: multiple choice with distractors built from it.
- **Produce before you're shown.** Prefer an answer the learner generates; multiple choice is for discrimination and warm-ups.
- **Difficulty.** Aim for about 85% success per retrieval event; step up, hold or step down by the last outcomes.
- **Hint ladder R0–R5 in teach and probe** (ported from practice §VI): give the smallest rung that unblocks; localize the break without giving the correction.
- **Foundation first** (decision 21).
- **Feedback always follows an attempt.** Correct a high-confidence error explicitly.
- **`requireThinking`.** Set it on generative and harder tasks; leave it off on warm-ups and predictions.

**Research basis** (cited in `docs/teaching-methodology.md`):
- Kang, McDermott & Roediger 2007: short answer with feedback beats multiple choice.
- Little & Bjork 2012/2014: multiple choice with competitive distractors.
- Kornell, Hays & Bjork 2009: failed retrieval helps when feedback follows.
- Sinha & Kapur 2021: productive failure needs prior knowledge.
- Kalyuga et al. 2003; Renkl et al. 2004; Salden et al. 2010: expertise reversal and adaptive fading.
- Wilson et al. 2019: the 85% rule.
- Butterfield & Metcalfe 2001: hypercorrection.
- Koedinger & Aleven 2007; Aleven et al. 2006: the assistance dilemma and help abuse.
- Bastani et al., PNAS 2025: unguarded GPT-4 access cut later exam scores by 17%; a hints-not-answers tutor avoided the harm, and learners overestimated how much they had learned.
- Kestin et al., Sci. Rep. 2025: a structured AI tutor beat active learning, best for introducing a topic.
- Pre-registered prequestion meta-analysis, Psychon. Bull. Rev. 2024: g = 0.54 on the asked material, about 0 on unasked material, so predictions target the step's core idea.
- Greving & Richter 2022; BMC Med. Educ. 2024; the 2017 meta-analysis: the format evidence is mixed, and hybrid practice works best, which supports Mixed.
- 2025 LLM-hint study (Int. J. AIED): about 35% of generated hints are too general, wrong or leak the answer (hence the deterministic leak check in Task 4).

- [ ] **Step 1:** Draft the prompt diffs and show them to the owner. **Stop until they are approved.**
- [ ] **Step 2:** Apply them. Run `npm test` (the prompt-composition tests, and the tool field names cited in prompts). Expect PASS.
- [ ] **Step 3:** Regenerate the fixture for the `quizMechanic` setting (fixture law), then run the full gate.
- [ ] **Step 4:** Commit, open the PR, merge it, then release and deploy (minor bump). On VM 104, check one teach session in Mixed mode: the agent mixes free recall and multiple choice according to concept state.

---

## PR 1: interactive exercises, core formats

### Task 1: Safe math-expression engine

**Files:**
- Create: `src/core/math-expr.ts`
- Modify: `src/core/index.ts` (re-export)
- Test: `tests/math-expr.test.ts`

**Interfaces:**
- Produces:
  - `type Expr` (AST)
  - `parseExpr(src: string): { ok: true; expr: Expr } | { ok: false; error: string }`
  - `evalExpr(expr: Expr, vars: Readonly<Record<string, number>>): number` (NaN on a domain error; never throws)
  - `parseNumberLike(src: string): number | null`
  - `exprEquivalent(a: string, b: string, variables: readonly string[], opts?: { rel?: number; abs?: number }): boolean`
- Grammar: numbers (decimal and scientific), `+ - * / ^`, unary minus, implicit multiplication (`2x`, `2pi`, `x(y+1)`), parentheses, and the functions `sqrt sin cos tan asin acos atan ln log exp abs`. The constants are `pi`, `π` and `e`. The parser is recursive descent; there is no `eval` and no `Function`.

- [ ] **Step 1: Write the failing tests**

```ts
test("parseNumberLike normalises", () => {
	assert.equal(parseNumberLike("1/3"), 1 / 3);
	assert.equal(parseNumberLike("−5"), -5);
	assert.equal(parseNumberLike("0,5"), 0.5);
	assert.equal(parseNumberLike("1e-3"), 0.001);
	assert.ok(Math.abs(parseNumberLike("2pi")! - 2 * Math.PI) < 1e-12);
	assert.equal(parseNumberLike("abc"), null);
});
test("evalExpr implicit multiplication and functions", () => {
	const r = parseExpr("2x^2 + sin(pi/2)");
	assert.ok(r.ok);
	assert.equal(evalExpr(r.expr, { x: 3 }), 19);
});
test("exprEquivalent skips shared poles", () => {
	assert.equal(exprEquivalent("1/x", "x^-1", ["x"]), true);
	assert.equal(exprEquivalent("(x^2-1)/(x-1)", "x+1", ["x"]), true);
	assert.equal(exprEquivalent("sqrt(x^2)", "x", ["x"]), false);
	assert.equal(exprEquivalent("1/0", "1/0", []), false); // < 4 valid points
});
test("parseExpr rejects unknown identifiers", () => {
	assert.equal(parseExpr("constructor(1)").ok, false);
	assert.equal(parseExpr("y + 1").ok, true); // free variables are allowed; equivalence fixes them
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing): `NODE_ENV=test npx tsx --test tests/math-expr.test.ts`
- [ ] **Step 3: Implement.** `exprEquivalent` evaluates both sides at 12 deterministic sample points. Each variable takes values from `seededRandom("expr:" + v)` mapped into [-5, 5], skipping |x| < 0.05. The tolerance is `|a-b| <= abs + rel·max(|a|,|b|)`, with defaults `rel 1e-6`, `abs 1e-9`. The comparison:
  - a point where both sides are NaN or ±Infinity is skipped;
  - a point where exactly one side is NaN or ±Infinity is a mismatch;
  - at least 4 compared points are needed for a match.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): safe math-expression parser and equivalence`

### Task 2: Exercise contract and graders (generative four)

**Files:**
- Create: `src/core/exercise-core.ts`
- Modify: `src/core/index.ts`
- Test: `tests/exercise-core.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseNumberLike`, `exprEquivalent`). Uses `seededRandom` and `shuffleOptions` from `question-core.ts`.
- Produces:
  - `INTERACTIVE_FORMATS = ["numeric","blanks","table","multipart","ordering","matching","spot-error","fields","sequence","plot","label","graph","code"] as const`, `type InteractiveFormat`
  - `PR1_FORMATS = ["numeric","blanks","table","multipart"] as const`
  - `IMPLEMENTED_FORMATS: readonly InteractiveFormat[]` (the formats with a grader in this build; it equals `PR1_FORMATS` now and grows in PR 4 and PR 5)
  - Spec types:
    - `NumericSpec { answer: string; mode: "number" | "expression"; variables?: string[]; tolerance?: { abs?: number; rel?: number }; unit?: string }`
    - `BlanksSpec { text: string; blanks: { id: string; accept: string[]; mode?: "text" | "number" | "expression"; caseSensitive?: boolean; variables?: string[] }[] }`. `text` holds `{{id}}` placeholders. There is no word bank.
    - `TableSpec { columns: string[]; rows: { cells: ({ given: string } | { id: string; accept: string[]; mode?: "text" | "number" | "expression" | "bit" })[] }[] }` (each row has `columns.length` cells; at least one editable cell)
    - `MultipartSpec { parts: { id: string; label: string; format: "numeric" | "blanks" | "table"; spec: unknown; weight?: number }[] }` (2–6 parts, no nesting)
  - `exerciseSpecProblems(format: string, spec: unknown): string[]` (empty means gradeable)
  - `type ItemVerdict = { id: string; correct: boolean; expected?: string; given?: string }`
  - `type ExerciseVerdict = { outcome: "correct" | "partly" | "wrong"; earned: number; total: number; items: ItemVerdict[]; summary: string }`
  - `gradeExercise(format: InteractiveFormat, spec: unknown, response: unknown): ExerciseVerdict`
  - `stripExpected(v: ExerciseVerdict): ExerciseVerdict` (removes `expected`; used for marks-only views)
  - Response shapes:
    - numeric: `{ value: string }`
    - blanks: `{ values: Record<string, string> }`
    - table: `{ values: Record<string, string> }`
    - multipart: `{ parts: Record<string, unknown> }`
  - Multipart items are namespaced `"<partId>.<itemId>"`. Weight defaults to 1. `earned`/`total` are weight-scaled sums, rounded to 2 decimals.

- [ ] **Step 1: Write the failing tests**

```ts
test("numeric honours tolerance", () => {
	const spec = { answer: "1/3", mode: "number", tolerance: { abs: 0.001 } };
	assert.equal(gradeExercise("numeric", spec, { value: "0.333" }).outcome, "correct");
	assert.equal(gradeExercise("numeric", spec, { value: "0.33" }).outcome, "wrong");
	assert.equal(gradeExercise("numeric", { answer: "9.81", mode: "number", unit: "m/s^2", tolerance: { rel: 0.01 } }, { value: "9.8 m/s^2" }).outcome, "correct");
});
test("numeric expression mode", () => {
	const spec = { answer: "2x", mode: "expression", variables: ["x"] };
	assert.equal(gradeExercise("numeric", spec, { value: "x + x" }).outcome, "correct");
});
test("blanks per blank, case and mode", () => {
	const spec = { text: "{{f}} = m{{a}}", blanks: [{ id: "f", accept: ["F"], caseSensitive: true }, { id: "a", accept: ["a"] }] };
	const v = gradeExercise("blanks", spec, { values: { f: "f", a: "A" } });
	assert.deepEqual([v.earned, v.total], [1, 2]);
});
test("table grades editable cells only, bit mode strict", () => {
	const spec = { columns: ["A", "B", "A∧B"], rows: [{ cells: [{ given: "0" }, { given: "1" }, { id: "r1", accept: ["0"], mode: "bit" }] }, { cells: [{ given: "1" }, { given: "1" }, { id: "r2", accept: ["1"], mode: "bit" }] }] };
	const v = gradeExercise("table", spec, { values: { r1: "0", r2: "yes" } });
	assert.deepEqual([v.outcome, v.earned, v.total], ["partly", 1, 2]);
});
test("multipart weights and namespacing", () => {
	const spec = { parts: [
		{ id: "a", label: "(a)", format: "numeric", spec: { answer: "2", mode: "number" }, weight: 2 },
		{ id: "b", label: "(b)", format: "blanks", spec: { text: "{{x}}", blanks: [{ id: "x", accept: ["y"] }] } },
	] };
	const v = gradeExercise("multipart", spec, { parts: { a: { value: "2" }, b: { values: { x: "z" } } } });
	assert.deepEqual([v.earned, v.total], [2, 3]);
	assert.ok(v.items.some((i) => i.id === "b.x" && !i.correct));
});
test("schema-valid iff gradeable", () => {
	assert.ok(exerciseSpecProblems("numeric", { answer: "abc(", mode: "number" }).length > 0);
	assert.ok(exerciseSpecProblems("table", { columns: ["A"], rows: [{ cells: [{ given: "1" }] }] }).length > 0); // no editable cell
	assert.ok(exerciseSpecProblems("multipart", { parts: [{ id: "a", label: "a", format: "multipart", spec: {} }] }).length > 0); // nesting
	assert.ok(exerciseSpecProblems("matching", {}).length > 0); // not implemented in this build
});
test("stripExpected removes answers", () => {
	const v = gradeExercise("blanks", { text: "{{x}}", blanks: [{ id: "x", accept: ["y"] }] }, { values: { x: "z" } });
	assert.equal(stripExpected(v).items[0]!.expected, undefined);
});
test("malformed response never throws", () => {
	assert.equal(gradeExercise("table", { columns: ["A"], rows: [{ cells: [{ id: "c", accept: ["1"] }] }] }, null).outcome, "wrong");
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** For a format not in `IMPLEMENTED_FORMATS`, `exerciseSpecProblems` returns `["format \"<f>\" is not available in this build"]`. `summary` is one line, e.g. `"1/2 blanks right"`, `"3/5 cells right"`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): exercise contract and graders for numeric/blanks/table/multipart`

### Task 3: `agent.formats` setting

**Files:**
- Modify: `src/core/settings.ts` (`AgentSettings.formats?: Record<string, boolean>`; `sanitizeAgent` parses it with `sanitizeBooleanMap`)
- Modify: `src/core/settings-resolution.ts` (`EffectiveSettings.agent.formats: Record<string, boolean>`; add `enabledFormats(effective): InteractiveFormat[]`)
- Modify: `src/server/settings-body.ts` (`parseAgentSettingsBody`: `formats` must be a boolean map whose keys are in `INTERACTIVE_FORMATS`, otherwise 400 `unknown format "<k>"`)
- Modify: `components/settings/agent-section.tsx` (a "Question formats" `SettingsGroup` with one `Toggle` row per implemented format; pure helper `composeFormats(agent, format, on): AgentSettings`)
- Test: `tests/exercise-settings.test.ts`

**Interfaces:**
- Produces: `enabledFormats(effective: EffectiveSettings): InteractiveFormat[]`. It returns the `IMPLEMENTED_FORMATS` whose key is not `false`, in `INTERACTIVE_FORMATS` order.

- [ ] **Step 1: Failing tests:**
  - `enabledFormats` of empty settings equals `PR1_FORMATS`.
  - `{formats:{table:false}}` drops `table`.
  - `parseAgentSettingsBody({formats:{bogus:true}})` returns `{ok:false}` with the error containing `bogus`.
  - `composeFormats` keeps other agent keys.
  - `renderToStaticMarkup(<AgentSection …/>)` contains `data-testid="format-row-numeric"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per the Files list. Row label is the format name title-cased; testid is `format-row-<format>`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(settings): per-format toggles (agent.formats)`

### Task 4: `exercise` / `assess` tools and the question plumbing

**Files:**
- Modify: `src/core/question-core.ts`
  - Add `exerciseInputBase` (fields in order: `question`, `format`, `explanation`, `spec`, `hints` (2–3 strings, escalating, never the answer), `requireThinking?`, `details?`, `concepts?`)
  - `quizInputBase`, `explainInputBase` gain a trailing optional `requireThinking?: boolean` (the schema-order test is updated)
  - Add `exerciseInputObject` (+ `type: "predict"|"check"`, `nodeId`)
  - Add `exerciseDisplayInputSchema`
  - `QuestionKind` gains `"exercise"`
  - `QuestionAnswerData` gains `format?: InteractiveFormat; response?: unknown; verdict?: ExerciseVerdict; attempts?: number; hintsUsed?: number; gaveUp?: boolean; firstAttempt?: { verdict: ExerciseVerdict; confidence?: number }`
  - `questionNeedsReveal` treats `exercise` like `quiz`
  - `compactAnswerForModel` emits `{kind:"exercise", format, outcome, earned, total, items, attempts, hintsUsed, gaveUp?, firstAttempt?, confidence?, thinking?, thinkingWhileReading?, dontKnow?}`
  - Add `buildExerciseAnswer(input, response, req: AnswerRequest & { attempts: number; hintsUsed: number; gaveUp: boolean; firstAttempt?: { verdict: ExerciseVerdict; confidence?: number } }, tool, toolCallId): QuestionAnswerData`, which sets `correct = verdict.outcome === "correct"` and keeps `req.confidence` (dropped on dontKnow, as `buildAnswer` does)
- Modify: `src/core/pending.ts` (`QUESTION_TOOLS` += `"exercise","assess"`; `toolQuestionKind` maps both to `"exercise"`)
- Modify: `src/core/tool-parts.ts` (`parseExerciseInput(raw)` mirrors `parseQuizInput`, then runs `exerciseSpecProblems`)
- Modify: `src/core/phases.ts` (`taggedNodeId` and `phaseAt3Lh` count a tagged `exercise` like `quiz`)
- Modify: `src/core/contracts/plan.ts` (`derivePlanStatuses` / `derivePlanStatusesLh`: `exercise` counts like `quiz`, with `answer.correct`)
- Modify: `src/core/contracts/learner.ts` (`EvidenceEvent.kind` += `"exercise" | "assess"`)
- Modify: `src/core/learner.ts`:
  - `EXERCISE_CALLS = ["exercise","assess"]`
  - add `exerciseItem(chat, call, answer, result): GradedItem | null`
    - dontKnow → `failed`
    - gaveUp → raw `"surrendered"`, `failed`, with a misconception from the first attempt's first wrong item (`term: given, instead: expected`)
    - correct with `attempts === 1 && hintsUsed === 0` → `clean`, or `weak`/"tentative" when confidence is at most `TENTATIVE_MAX_CONFIDENCE`
    - correct otherwise → raw `"correctWithHelp"`, `weak`
    - partly → raw `"partly"`, `weak`
    - wrong → raw `"miss"`, `failed`, with the misconception as above
    - predictions are skipped, as for quiz
- Modify: `src/agent/tools.ts`:
  - `teachExerciseToolFor(ctx, formats)` (name `exercise`, nodeId validated like `teachQuizToolFor`)
  - `probeExerciseToolFor(ctx, formats)` (name `assess`)
  - `format: Type.Union(formats.map((f) => Type.Literal(f)))` (the repo's existing literal-union pattern, as for `problem.mode`)
  - `spec: Type.Object({}, { additionalProperties: true })`, whose description lists every enabled format's fields
  - execute runs `exerciseSpecProblems`, checks there are 2–3 `hints` and that none leaks the answer (`hintLeaks(format, spec, hints): string[]` in `exercise-core.ts`: a hint containing any `accept` value or the numeric `answer`, compared case-insensitively on whitespace-normalised text with values shorter than 2 characters ignored, is refused), then runs `conceptsProblems`, then `questionResult()`
  - registered in `createProberTools` / `createTeacherTools` only when `formats.length > 0`
  - `ProberToolContext` / `TeacherToolContext` gain `formats?: InteractiveFormat[]` (default `[]`)
- Modify: `src/agent/tools/practice.ts` (`problemInputObject` gains `format?` + `spec?`; when present they are validated by `exerciseSpecProblems`; `PracticeToolContext.formats?`)
- Modify: `src/core/native-messages.ts` (`newThinkingMessage(problemCallId, text, attempt?: { format: InteractiveFormat; response: unknown; verdict: ExerciseVerdict })`; marker content appends `Attempt: <verdict.summary>` + per-item ✓/✗ and never the expected values)
- Modify: `src/core/input-events.ts` (`thinking` input gains optional `attempt`; `inputAppends` re-grades it server-side with `gradeExercise` against the active problem's spec and refuses a mismatch)
- Modify: `src/server/chat-handler.ts` (pass `formats: enabledFormats(effective)` into all three agent contexts)
- Modify: `src/core/session-markdown.ts` (render exercise/assess answers: the format, `earned/total`, and per-item ✓/✗, beside the existing quiz/explain branch at :96)
- Test: `tests/exercise-tools.test.ts`, plus additions to `tests/learner-evidence.test.ts`, `tests/phases.test.ts`, `tests/practice-record.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - tool names `exercise` (teach) and `assess` (probe)
  - `QuestionAnswerData.verdict`
  - `buildExerciseAnswer`
  - `parseExerciseInput(raw: unknown): { ok: true; input: ExerciseToolInput } | { ok: false }`
  - `type ExerciseToolInput`

- [ ] **Step 1: Failing tests** (mirror `tests/question-tools.test.ts`):
  - `exercise tool absent when formats empty`.
  - `assess rejects an ungradeable spec`: execute with a table that has no editable cell returns `isError`, with the problem text.
  - `exercise requires 2-3 hints`.
  - `exercise refuses a hint that leaks an accepted answer`.
  - `exercise refuses an unknown nodeId`.
  - `format enum lists only enabled formats`: the schema's literal union equals `["numeric","table"]` when given those two.
  - `buildExerciseAnswer grades and compacts`: the compacted answer for a half-right blanks exercise shows `outcome:"partly", earned:1, total:2, attempts, hintsUsed`, and no `expected` fields.
  - `exerciseItem maps partly to weak`, `exerciseItem low-confidence correct is tentative`.
  - `exerciseItem: correct after retries is weak`, `exerciseItem: hint used makes correct weak`, `exerciseItem: give-up is surrendered`.
  - `tagged exercise advances plan to teach`.
  - `practice thinking attempt is re-graded`: a client claim of `correct` against a wrong response is refused.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per the Files list. `turn-service.ts` already drops clean `QUESTION_TOOLS` placeholders, so no change is needed there. Confirm this with a test in `tests/exercise-tools.test.ts`: `exercise placeholder result is not persisted`.
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `feat(agent): exercise/assess question tools with browser grading`

### Task 5: Exercise widgets, dock and answered card

**Files:**
- Create: `components/exercise/exercise-widget.tsx`
  - `ExerciseWidget({ format, spec, toolCallId, value, onChange, review?: ExerciseVerdict, marksOnly?: boolean })` (`marksOnly` shows ✓/✗ without `expected`)
- Create: `components/exercise/attempt-state.ts` (`exerciseAttemptReducer(state, action)`: the pure reducer for check, retry, hint, give-up and submit)
  - It dispatches to one file per format: `numeric-widget.tsx`, `blanks-widget.tsx` (inline inputs inside rendered markdown), `table-widget.tsx` (given cells read-only, editable cells as inputs, Tab moves between editable cells), `multipart-widget.tsx` (labelled sections that each render the child widget)
- Modify: `components/question-dock.tsx`
  - `toolName` union += `"exercise" | "assess"`
  - for these tools `QuestionDockForm` renders `ExerciseWidget` in place of the option list, keeps the "I don't know" row, the confidence rail (shown for `kind === "exercise"` as for quiz) and the "Your thinking" field, and submits `buildExerciseAnswer(...)`
  - the up/down keyboard machine is off while focus is inside the widget, which counts as a typing surface
  - **The attempt loop** (teach and probe):
    - "Check" grades locally and shows `stripExpected` marks, then lets the learner edit and Check again.
    - A correct Check submits.
    - "Show answer" submits with `gaveUp: true`.
    - The dock counts `attempts` and captures `firstAttempt` (verdict + confidence) on the first Check.
  - **"Hint (n left)"** reveals the next pre-written hint inline and counts `hintsUsed`.
  - **`requireThinking`:** Check, Submit and Show answer stay disabled until "Your thinking" has text. "I don't know" stays enabled.
  - Dock state (attempts, hints shown, response) is local and unmounts with the question, like `confIdx`
- Modify: `components/answered-card.tsx` (an exercise answer renders `ExerciseWidget` in review mode plus `explanation`)
- Modify: `components/practice-dock.tsx` (a "Hint" button sends the `hint` input from Task 9 — before PR 2 lands it sends the thinking text `I'd like a hint.`; when `input.format` is set: render `ExerciseWidget`, add a "Check" button that sends `thinking` with `attempt`, then show per-item ✓/✗ from the verdict (`review` with `marksOnly: true`). Expected values are never shown before `conclude`.)
- Modify: `components/practice-cards.tsx` (`ThinkingCard` shows the attempt summary; `ConcludeCard` shows the widget in review mode with expected values)
- Modify: `components/chat.tsx:1515-1528` (add `"tool-exercise"|"tool-assess"` to the `AnsweredCard` case)
- Test: `tests/render-exercise.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`parseExerciseInput`, `buildExerciseAnswer`, `exerciseDisplayOrder`).

- [ ] **Step 1: Failing render tests** (`renderToStaticMarkup`, mirror `tests/render-cards.test.tsx`). Each format renders an input state containing `data-testid="exercise-<format>"`. The review state marks wrong items with `data-correct="false"`. These names are pinned:
  - `check shows marks without the key`: after a wrong Check, the markup has `data-correct="false"` and no expected value.
  - `hints reveal one at a time`.
  - `requireThinking disables check until thinking`.
  - `show answer submits gaveUp`: a pure reducer `exerciseAttemptReducer` is tested directly.
  - `practice dock never leaks expected values`: after a wrong Check on a blanks problem, the markup carries `data-correct="false"` on the wrong blank but does not contain the accepted answer.
  - `answered exercise card shows verdict`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Every label and blank `text` renders through the existing markdown/KaTeX path (`MessageResponse`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): exercise widgets, attempt loop and hints`

### Task 6: Prompt mechanics, fixtures, release

**Files:**
- Create: `src/agent/prompts/shared/22-exercise-tools.md` (mechanics only)
  - When the exercise tool beats a quiz (a computed value, fill-ins, a worked table, a multi-step problem).
  - The `hints` ladder: 2–3 rungs, smallest first, never the answer.
  - `attempts`, `hintsUsed`, `gaveUp` and `firstAttempt` arrive with the answer; react to the first attempt's high-confidence errors explicitly.
  - Each format's `spec` fields, verbatim.
  - "The spec is your committed answer key; write `explanation` before the spec."
  - "Partial credit arrives as `earned`/`total` with per-item verdicts — address the wrong items."
- Modify: `src/agent/prompts/practice/00-base.md` (the optional `format` + `spec` on `problem`, and the multi-attempt `Attempt:` lines)
- Test: extend the existing prompt-composition test with `22-exercise-tools.md cites only schema field names` (assert that each backticked field in the fragment exists in `exerciseInputBase` or a format spec)
- Fixtures: regenerate by running the app. Include a teach chat with answered `exercise` calls: one first-try correct, one after retries with a hint, and one give-up (fixture law).

- [ ] **Step 1:** Write the fragment and the test. Run it and expect PASS.
- [ ] **Step 2:** Run the full gate (Global Constraints). Expect clean.
- [ ] **Step 3:** Manual check: run `npm run dev`, then in a teach session and a practice session have the agent pose one of each format. Grade right, partly and wrong answers, and confirm the learner graph shows the evidence.
- [ ] **Step 4:** Commit `feat(prompts): exercise tool mechanics`. Open the PR and merge it, then release and deploy (minor bump).

---

## PR 2: canvas workspace with `work` / `sketch`

### Task 7: Drawing scene contract

**Files:**
- Create: `src/core/canvas-core.ts`
- Modify: `src/core/index.ts`
- Test: `tests/canvas-core.test.ts`

**Interfaces:**
- Produces:
  - `DrawingScene { version: 1; objects: DrawingObject[] }`. The view (pan/zoom) is client-only and is never hashed.
  - `DrawingObject` is a union discriminated by `type`. Every object carries `id: string` and `z: number`:
    - `stroke { brush: "pen"|"pencil"|"marker"; color: string; size: number; points: [number, number, number][] }`
    - `shape { shape: "line"|"arrow"|"rect"|"ellipse"; color: string; strokeWidth: number; x1; y1; x2; y2 }`
    - `text | markdown | latex { x; y; w; h; source: string }`
    - `table { x; y; w; h; cells: string[][] }`
    - `image { x; y; w; h; assetId: string }`
  - Typed objects (text/markdown/latex/table/image) use ids `o1, o2, …`, allocated by `nextObjectId(scene)`. Strokes and shapes use `s<n>`.
  - `validateDrawingScene(raw: unknown): { ok: true; scene: DrawingScene } | { ok: false; error: string }`. Limits: at most 20 000 objects, at most 200 000 points total, string `source` at most 20 000 chars.
  - `canonicalJson(value: unknown): string` (sorted keys)
  - `sha256Hex(bytes: Uint8Array): string` (pure JS)
  - `drawingIdOf(scene): string`
  - `sceneBoundingBox(scene, padding = 32): Box | null` (`Box = { x; y; w; h }`)
  - `regionGrid(box: Box): { cols: 8; rows: number; cellW: number; cellH: number }`
  - `cellOf(grid, box, x, y): string` (e.g. `"C4"`)
  - `cellRect(grid, box, cell): Box | null`
  - `objectsAt(scene, box)` returns the ids of typed objects in each cell
  - `serializeSceneStructuredText(scene, box): string` (one line per typed object: `[o3 latex @C4] $\int_0^1 x\,dx$`; tables as markdown under `[o5 table @B6-D7]`)

- [ ] **Step 1: Failing tests:**
  - `drawingIdOf is stable across key order and ignores view`.
  - `validateDrawingScene rejects oversize and unknown types`.
  - `sceneBoundingBox covers strokes, shapes and blocks with padding`.
  - `regionGrid rows follow aspect`: a 1600×800 box gives 4 rows, 800×1600 gives 16, 100×5000 is clamped to 16.
  - `cellOf/cellRect round-trip`.
  - `serializeSceneStructuredText tags typed objects with cells`: the exact string for a two-object scene.
  - `sha256Hex matches a known vector`: `sha256Hex(new TextEncoder().encode("abc"))` equals `"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): drawing scene contract, region grid, content ids`

### Task 8: DrawingStore, routes, the chat `canvas` setting

**Files:**
- Modify: `config.ts` (`PATHS.drawings = path.join(DATA_ROOT, "drawings")`)
- Modify: `src/core/ports.ts`: add `DrawingStore`:
  ```ts
  interface DrawingStore {
  	saveSubmission(chatId: string, scene: DrawingScene, png: Uint8Array): { drawingId: string };
  	getScene(chatId: string, drawingId: string): DrawingScene | null;
  	getPng(chatId: string, drawingId: string): Uint8Array | null;
  	saveAsset(chatId: string, bytes: Uint8Array, mimeType: "image/png" | "image/jpeg"): { assetId: string };
  	getAsset(chatId: string, assetId: string): { bytes: Uint8Array; mimeType: string } | null;
  	readDraft(chatId: string, callId: string): { scene: DrawingScene; rev: number } | null;
  	writeDraft(chatId: string, callId: string, scene: DrawingScene, baseRev: number): { ok: true; rev: number } | { ok: false; current: { scene: DrawingScene; rev: number } };
  	readTranscript(chatId: string, drawingId: string): { model: string; text: string } | null;
  	writeTranscript(chatId: string, drawingId: string, t: { model: string; text: string }): void;
  	deleteForChat(chatId: string): void;
  }
  ```
- Create: `src/store/drawings.ts`
  - Mirror `src/store/documents.ts`: `writeAtomic` / `writeAtomicBytes`, reads never throw, ids checked by regex (`/^drw_[0-9a-f]{12}$/`, `/^ast_[0-9a-f]{12}$/`, chat and call ids `/^[A-Za-z0-9_-]+$/`).
  - `saveSubmission` computes `drawingIdOf(scene)` itself and skips the write when `<id>.json` already exists.
  - Construction does no `mkdir` (fixture law).
- Modify: `src/server/stores.ts` (wire `drawingStore`)
- Modify: `src/server/chats.ts` (`deleteChatSession` calls `drawingStore.deleteForChat` in the sync block, after `jobStore.deleteJobsForChat`)
- Modify: `src/core/contracts/chat.ts` (`ChatSettings.canvas?: boolean`)
- Modify: `src/server/settings-body.ts` (`parseSettingsBody` accepts `canvas: boolean`)
- Modify: `app/api/chats/[id]/settings/route.ts` (merge: `next = { ...existing, ...parsed }`, so an omitted `canvas` or `model` key is preserved)
- Modify: `app/api/chats/route.ts` (accept `canvas?: boolean` on POST and stamp it with the strong-slot settings)
- Create the routes (read `node_modules/next/dist/docs/` on route handlers first; params is a Promise):
  - `app/api/chats/[id]/drawings/route.ts`: `POST` multipart (`scene` JSON + `png` file). Validates the scene, checks the PNG magic bytes and enforces at most 10 MB. Returns `{ drawingId }`.
  - `app/api/chats/[id]/drawings/[drawingId]/route.ts`: `GET` returns `?format=png` as `image/png` with `Cache-Control: private, max-age=31536000, immutable` (content-addressed); otherwise it returns `{ scene }`.
  - `app/api/chats/[id]/drawings/assets/route.ts` (`POST` multipart `file`, at most 5 MB, PNG/JPEG magic) and `assets/[assetId]/route.ts` (`GET`, immutable).
  - `app/api/chats/[id]/drawings/drafts/[callId]/route.ts`: `GET` returns `{ scene, rev } | 404`. `PUT { scene, baseRev }` returns `{ rev }`, or 409 with the current `{ scene, rev }` when `baseRev` is stale.
- Test: `tests/drawings-store.test.ts` (isolated `LH_DATA_DIR`, dynamic imports), `tests/drawings-routes.test.ts`

**Interfaces:**
- Consumes: Task 7.
- Produces: `stores.drawingStore`, the routes above, `ChatSettings.canvas`.

- [ ] **Step 1: Failing tests:**
  - `saveDrawing is idempotent by content`: saving twice returns the same id and leaves one `.json` file.
  - `draft round-trips`.
  - `stale draft write is refused with the current draft`.
  - `rejects traversal ids`: `getScene("../x", …)` returns null.
  - `deleteForChat removes the folder`.
  - `deleteChatSession removes drawings`.
  - `POST rejects non-PNG bytes` (400).
  - `GET png sets immutable cache`.
  - `settings PUT preserves canvas across a model change`: PUT `{canvas:true}`, then PUT `{model}`, then the record has both.
  - `POST /api/chats stamps canvas`.
  - `store construction writes nothing`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(store): drawing store, drawing routes, chat canvas setting`

### Task 9: `work` / `sketch` lifecycle in the record

**Files:**
- Modify: `src/core/question-core.ts`
  - `workInputObject`: `type: "predict"|"check"`, `nodeId`, `question`, `correctAnswer`, `requireThinking?`, `details?`, `concepts?`
  - `sketchInputObject`: `question`, `correctAnswer`, `requireThinking?`, `details?`, `concepts?`
  - `workInputProblems`
  - `questionNeedsReveal("work", …)` follows the quiz rule
- Modify: `src/core/native-messages.ts`
  - `customType` += `"work-submission" | "work-dismissed" | "hint-request"`
  - `newWorkSubmission(workCallId, text, drawingId?)`: content is `` `${THINKING_LABEL}:\n${text}` `` plus `\n[drawing ${drawingId}]` when present; details are `{ workCallId, text, drawingId? }`
  - `newWorkDismissedMarker(workCallId)`
  - `WORK_TOOLS = ["work","sketch"] as const`
  - `activeWorkOf(messages): { toolCallId: string; tool: "work" | "sketch"; input: unknown } | null` (the last clean-acked work/sketch with no later `grade` whose `question === toolCallId` and no `work-dismissed` for it)
  - `needsContinuation` returns false on a clean work/sketch ack, as for `problem`
  - `endsInDismissal` is also true when the last message is a `work-dismissed` marker
- Modify: `src/core/input-events.ts`
  - `ChatInput` += `{ type: "work-submit"; workCallId: string; text: string; drawingId?: string }` (`inputAppends` validates it against `activeWorkOf`, refuses it while `danglingQuestionOf` is non-null (the side question is answered first), and checks that the drawing exists through an injected `drawingExists(chatId, id)`)
  - `DismissInput` += `{ type: "dismiss-work"; workCallId: string }` (`dismissAppends` appends `newWorkDismissedMarker`)
  - `ChatInput` += `{ type: "hint"; callId: string }`. It is valid when `callId` is the active work/sketch or the active practice problem, and appends `newHintRequest(callId)`.
  - The marker content is `"Hint, please — give the next rung only."`, with details `{ callId }`.
- Modify: `src/core/view.ts` (`isPlaceholderResultTool` += work/sketch; `projectMarker` emits `data-work-submission` and `data-work-dismissed`)
- Modify: `src/core/phases.ts`, `src/core/contracts/plan.ts` (a tagged `work` counts like `explain`)
- Modify: `src/core/learner.ts` (`answeredRecallIds` / `ungradedAnsweredRecalls` include work/sketch calls with at least one submission; the graded item kind is `"work"|"sketch"`, the answer is the last submission's text, and `[drawing]` is appended when a drawing is present)
- Modify: `src/core/contracts/learner.ts` (`EvidenceEvent.kind` += `"work" | "sketch"`)
- Create: `src/agent/tools/work.ts`
  - `teachWorkToolFor(ctx)` (`work`) and `probeSketchToolFor(ctx)` (`sketch`)
  - refused while `activeWorkOf` is non-null (one canvas task at a time); side questions (quiz/explain/exercise/ask) stay allowed while a task is open
  - returns `workResult()`
- Modify: `src/agent/tool-execute.ts` (`workResult()` mirrors `problemResult()` with the text `"Canvas task posed — the turn ends here; the learner's submissions arrive as labeled messages until you grade."`)
- Modify: `src/agent/tools.ts`
  - register work/sketch when `ctx.canvas === true`
  - extend `gradeFor`: register `grade` also when `ctx.canvas === true` or `activeWorkOf(record.messages)` is non-null
  - contexts gain `canvas?: boolean`
- Modify: `src/agent/tools/grade.ts` (accept work/sketch call ids from `answeredRecallIds`; the tool description says grading a work call closes it; add optional `rung: "R0"…"R5" | null` for work/sketch, the highest hint rung given)
- Modify: `src/core/learner.ts` (a work/sketch graded `correct` with `rung` R2 or above maps to raw `"correctWithHelp"`, `weak`)
- Modify: `src/agent/tools/probe.ts` (`probe_done` is also refused while `activeWorkOf` is non-null)
- Modify: `src/core/pending.ts` (`ACTIVITY_LABELS`: `work`/`sketch` → "Posing a canvas task…", `annotate` → "Marking up your work…")
- Modify: `src/core/session-markdown.ts` (render the work/sketch pose, each submission's text plus `![drawing](<drawingId>)`, and annotate mark lists)
- Modify: `src/agent/teacher-agent.ts` (`makeQuestionStopper` stops on work/sketch too)
- Modify: `app/api/chat/route.ts` and `handleChatRequest` (`src/server/chat-handler.ts`):
  - the request body gains `canvasCapable?: boolean` beside `input`;
  - the handler passes `canvas: record.settings?.canvas === true && canvasCapable === true` into the agent contexts;
  - server-initiated turns (the wake pipeline in `src/server/jobs.ts`) pass `canvasCapable: false`;
  - `grade` stays armed whenever a work task is open, whatever the device.
- Modify: `app/api/chats/[id]/dismiss/route.ts`, `src/server/dismissal-park.ts` (route `dismiss-work`)
- Test: `tests/work-lifecycle.test.ts` (mirror `tests/practice-record.test.ts` and `tests/dismissal-park.test.ts`)

**Interfaces:**
- Consumes: Task 8 (`DrawingStore` for the `drawingExists` check).
- Produces: `activeWorkOf`, `WORK_TOOLS`, `newWorkSubmission`, the `work-submit` / `dismiss-work` inputs, `data-work-submission` parts, `workResult`.

- [ ] **Step 1: Failing tests:**
  - `work pose ack persists and does not auto-continue`.
  - `submissions append markers while active`.
  - `work-submit refused when no active work`.
  - `work-submit refused for unknown drawing`.
  - `grade closes work`: after `grade{question: workCallId}`, `activeWorkOf` is null.
  - `dismiss-work closes and pauses wake`.
  - `second work refused while one is open`.
  - `grade armed when canvas on`.
  - `graded work becomes evidence`.
  - `probe_done refused during open sketch`.
  - `quiz allowed while work open; work-submit refused until it is answered`.
  - `hint input appends a marker for the active task only`.
  - `work graded correct at R3 is weak evidence`.
  - `phone turn has no work tool but keeps grade`: `canvasCapable: false` with an open work task means the registry has `grade` but no `work`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `feat(agent): work/sketch canvas tasks closed by grade`

### Task 10: Drawings in the model context, vision transcription

**Files:**
- Modify: `src/core/native-messages.ts`: `toLlmMessages(messages, opts?: { drawing?: DrawingContext })`, where
  ```ts
  interface DrawingContext {
  	/** Called only for drawings of the ACTIVE work/sketch/problem. */
  	resolve(drawingId: string): { png?: { data: string; mimeType: "image/png" }; transcript?: string; structured: string } | null;
  }
  ```
  - Only the **newest** drawing submission of the active task is sent as an image. Earlier submissions of the same task get the text stub `[earlier drawing <id> — superseded]` plus their structured text.
  - That newest `work-submission` or `practice-thinking` marker, whose `drawingId` belongs to the active task (`activeWorkOf` / `activeProblemOf`), becomes a user message:
    - `[text(marker.content + "\n" + GRID_NOTE + structured), image(png)]` when `png` is present;
    - otherwise `[text(marker.content + "\nTranscription:\n" + transcript + structured)]`.
  - A marker for a closed task becomes text only: `marker.content + "\n[Drawing <id> omitted — task closed]\n" + structured`. `structured` is re-resolved; if the resolver returns null, only the stub is used.
  - `GRID_NOTE` is a constant explaining the A–H column / numbered row grid and the `oN` object ids.
  - `newThinkingMessage` gains an optional `drawingId` (practice canvas).
- Modify: `src/agent/teacher-agent.ts` (`AgentBuildOptions.drawing?: DrawingContext`; `convertToLlm: (m) => toLlmMessages(m, { drawing: opts.drawing })`)
- Modify: `src/core/settings.ts` (`ModelRole` += `"transcriber"`; `ROLE_SLOT.transcriber = "vision"`; add it to `BackgroundModelRole` so the per-role override works)
- Create: `src/agent/subagents/drawing-transcriber.ts`
  - `createDrawingTranscriber(deps: { engineFor(role: "transcriber"): PiEngine | undefined }): { transcribe(png: Uint8Array, structured: string): Promise<{ model: string; text: string }> }`
  - The prompt ports the handwriting and math rules of `SCAN_PROMPT` (`services/ocr/app/pipeline.py:21-45`): LaTeX for math, Mermaid for diagrams, `~~struck~~` for crossed-out work. It also tags every region as `[C4]` / `[B2-D3]` using the grid.
- Modify: `src/core/compaction.ts` (`ESTIMATED_IMAGE_CHARS = 11_200`)
- Create: `src/server/drawing-context.ts`
  - `prepareDrawingContext(record, engine, deps): Promise<DrawingContext>`
  - `modelReadsImages = engine.model.input.includes("image")`
  - In text-only mode it transcribes, before the turn, every active-task drawing that has no cached transcript, and writes the cache. A failure leaves `transcript` undefined; the resolver then returns the stub path, plus the `transcription unavailable` line.
- Modify: `src/server/chat-handler.ts` (await `prepareDrawingContext` after engine resolution and pass `drawing` into `AgentBuildOptions`)
- Test: `tests/drawing-context.test.ts` (faux core and a stubbed store)

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces: `DrawingContext`, `createDrawingTranscriber`, `prepareDrawingContext`, the `transcriber` role.

- [ ] **Step 1: Failing tests:**
  - `active drawing sent as image to multimodal model`: the last user message content has a `{type:"image"}` block.
  - `closed task collapses to stub`: there is no image block, and the text contains `omitted — task closed`.
  - `text-only model gets cached transcript`: the transcriber is called once across two turns.
  - `text-only without transcriber falls back to stub`: `engineFor` returns undefined, the turn builds, and the text contains `transcription unavailable`.
  - `transcriber failure is contained`: the faux core throws, and `prepareDrawingContext` resolves.
  - `only the newest drawing is an image`: two submissions give one image block and one superseded stub.
  - `compaction estimate counts the image`: `ESTIMATED_IMAGE_CHARS` is raised to 11 200 (about 2 800 tokens, a 2048×1024 PNG); assert the new estimate.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(agent): drawings in context with vision-slot transcription fallback`

### Task 11: Canvas engine

**Files:**
- Modify: `package.json` (dependency `"perfect-freehand": "1.2.3"`)
- Create: `components/canvas/geometry.ts` (pure, unit-tested):
  - `strokeOutline(points, brush, size): [number, number][]` (calls `getStroke`, with presets `pen: {thinning 0.6, smoothing 0.5, streamline 0.4}`, `pencil: {thinning 0.2, smoothing 0.3, streamline 0.2}`, `marker: {thinning 0, smoothing 0.6, streamline 0.5}`)
  - `screenToWorld` / `worldToScreen(view)`
  - zoom and pinch reuse `zoomedGraphView` / `pinchView` from `components/pan-zoom.ts` (floor 0.1, the shared `ZOOM_MAX` 4) — do not fork the math
  - `hitTest(scene, worldPt, radius): string | null`
  - `eraseAt(scene, worldPt, radius): DrawingScene`
- Create: `components/canvas/canvas-engine.ts`
  - `class CanvasEngine { constructor(root: HTMLElement, opts); setScene(scene); setTool(tool); setBrush(b); undo(); redo(); getScene(): DrawingScene; exportPng(): Promise<Blob>; destroy() }`
  - Two stacked canvases: a cached static layer and a live stroke layer.
  - Pointer handling:
    - `touch-action: none`
    - pen input uses `getCoalescedEvents()`
    - `penSeen` latches on the first `pointerType === "pen"` event (page lifetime). Once set, one finger pans and touch never draws; before that, one finger draws.
    - two touch pointers always pan and pinch-zoom
    - the eraser removes whole strokes or objects (no stroke splitting)
  - Undo/redo is a stack of scene snapshots (at most 100).
  - `exportPng` renders `sceneBoundingBox` at 2× (long side at most 2048 px) and overlays the `regionGrid`: faint lines, column letters along the top, row numbers on the left, and a small `oN` badge at the top-left of each typed object.
  - The export is **always dark ink on white**, whatever the theme. The palette is stored as theme-neutral names (`ink`, `red`, `blue`, `green`, `orange`, `purple`, `gray`, `highlight`), mapped to light or dark colours on screen and to the light set for export.
  - Points are quantized when stored: x/y to 0.1, pressure to 0.01. Mouse and finger strokes use `simulatePressure: true`.
  - Low latency:
    - the live layer uses `getContext("2d", { desynchronized: true })` when `getContextAttributes().desynchronized` confirms support, otherwise a normal context;
    - redraws are batched to `requestAnimationFrame`;
    - pointer handling never touches React state, which only learns of a finished stroke.
  - iPad Safari: the canvas root sets `-webkit-user-select: none`, `-webkit-touch-callout: none` and `touch-action: none`, and calls `preventDefault` on `touchstart`/`gesturestart`, so there is no loupe, no selection and no page zoom. Coalesced events are used when `getCoalescedEvents` exists, with a fallback to plain events.
- Test: `tests/canvas-geometry.test.ts`

**Interfaces:**
- Consumes: Task 7.
- Produces: `CanvasEngine`, `CanvasTool = "select"|"pan"|"pen"|"pencil"|"marker"|"line"|"arrow"|"rect"|"ellipse"|"eraser"|"text"|"markdown"|"latex"|"table"|"image"`.

- [ ] **Step 1: Failing tests:**
  - `touch policy: finger draws until a pen is seen, then pans` (pure `touchRole(penSeen, touchCount): "draw" | "pan"`).
  - `screen/world round-trip`.
  - `hitTest finds a stroke within radius`.
  - `eraseAt removes only touched objects`.
  - `strokeOutline marker is wider than pencil`, at the same size.
  - `quantize rounds points`.
  - `export palette ignores theme`: `exportColor("ink")` is the same in light and dark.
  - `render budget`: a pure `visibleObjects(scene, viewBox)` culls a 10 000-stroke scene to the viewport in under 5 ms (node timing, generous bound).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** geometry, then the engine.
- [ ] **Step 4: Run, expect PASS.** Then manually check on the dev server, with an iPad and Apple Pencil, that:
  - inking has no visible lag;
  - a resting palm draws nothing;
  - two-finger pan and pinch work;
  - the exported PNG shows the grid and the badges.
- [ ] **Step 5: Commit** `feat(ui): canvas engine on perfect-freehand`

### Task 12: Canvas workspace, work dock, cards, Canvas pill, practice canvas

**Files:**
- Create: `components/canvas/canvas-objects.tsx` (world-positioned overlay editors: plain text, markdown via `MessageResponse`, LaTeX via `katex.renderToString(src, { trust: false, throwOnError: false })`, tables with add/remove row and column and Tab navigation, images with paste/upload going to the assets route and a corner resize)
- Create: `components/canvas/canvas-workspace.tsx`
  - `CanvasWorkspace({ chatId, callId, question, onSubmit(text, drawingId), onMinimize })`
  - A session-area overlay, mounted like `MermaidOverlay` (sibling of the scroller inside the session area; `useBackDismiss`; Esc claimed at the document level). It has a question strip, the toolbar (the `CanvasTool`s, undo/redo, 8-colour palette, size, zoom reset, minimise), and a bottom bar with "Your thinking" and Submit.
  - Loads the draft on open and autosaves through `PUT drafts/<callId>` with a 2 s debounce.
  - Its "Your thinking" field claims dictation (`useDictationTarget`) while open.
  - A "Hint" button sends `{ type: "hint", callId }`.
  - `requireThinking` gates Submit.
  - On a 409 from the draft PUT, the newer draft is loaded and a notice shows ("Updated from your other device").
  - Every autosave is also mirrored to `localStorage` under `lh:draft:<chatId>:<callId>` (try/catch). On open, the newer of server and local wins, so going offline mid-task loses nothing.
  - Submit exports the PNG, POSTs it to `/drawings`, then calls `onSubmit` with the returned `drawingId`. An empty scene submits text only.
- Create: `components/use-canvas-capable.ts` (`useCanvasCapable(): boolean` = `Math.min(screen.width, screen.height) >= 600`; false during SSR)
- Create: `components/work-dock.tsx` (`WorkDock({ chatId, active, requiresReveal, canvasCapable, onSubmit, onDismiss })`: a minimised bar with "Open canvas" and a text field that claims dictation, plus the reveal variant like `QuestionDockBar`. When `canvasCapable` is false it hides "Open canvas" and shows "Draw on a tablet or computer".)
- Create: `components/work-cards.tsx` (`WorkCard` for the pose, `WorkSubmissionCard` for the `data-work-submission` part with a thumbnail from `GET …/drawings/<id>?format=png` plus the text)
- Modify: `components/artifacts/grade-chip.tsx` (for a work/sketch target, reveal `correctAnswer`)
- Modify: `components/practice-dock.tsx`, `components/practice-cards.tsx` ("Open canvas" when `input.canvas` is set; `ThinkingCard` thumbnail)
- Modify: `src/agent/tools/practice.ts` (`problemInputObject` gains `canvas?: boolean`, accepted only when the session canvas is on)
- Modify: `components/session-core.ts` (`submitWork(workCallId, text, drawingId?)`, `dismissWork(workCallId)`; optimistic append for `work-submit`)
- Modify: `components/chat.tsx`
  - dock selection at :2361-2389: `pending` → `QuestionDock` (side questions win); else `activeWork` → `WorkDock`; else `activeProblem` → `PracticeDock`; else the composer
  - every chat POST from `session-core.ts` sends `canvasCapable: useCanvasCapable()`
  - :1369-1393 renders `data-work-submission`
  - `escAbortTarget` :1785: an open workspace minimises first, then the next Esc offers dismissal
  - the pending `canvasOpen` state lives in chat.tsx
- Modify: `components/stats-bar.tsx`, `components/home.tsx`, `components/new-session.tsx`, `components/model-picker.tsx`
  - a `CanvasPill({ chatId?, value?, onChange? })` beside `ModelControl` (`data-testid="stats-canvas"`)
  - hidden when `useCanvasCapable()` is false
  - draft mode: local state, default `false`, sent as `canvas` on `POST /api/chats` by `startDraftSession` and the home equivalent
  - session mode: PUT `{ canvas }`
- Test: `tests/render-canvas.test.tsx`, `tests/esc-layering.test.ts` (extend), `tests/session-core.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 8–11.

- [ ] **Step 1: Failing tests:**
  - `WorkDock renders open-canvas and text fallback`.
  - `WorkDock phone fallback`: with `canvasCapable={false}` there is no `open-canvas` testid and the hint text is present.
  - `CanvasPill hidden when not canvas-capable`.
  - `side question takes the dock over an open work task`.
  - `WorkSubmissionCard shows thumbnail url`.
  - `CanvasPill off by default in draft`.
  - `CanvasPill reflects session setting`.
  - `startDraftSession sends canvas`.
  - `esc minimises canvas before dismissing work`.
  - `submitWork appends optimistically`.
  - `hint button sends hint input`.
  - `local draft wins when newer` (pure `pickDraft(server, local)`).
  - `practice problem canvas refused when session canvas off`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): canvas workspace, work dock and canvas pill`

### Task 13: Prompt mechanics, fixtures, release

**Files:**
- Create: `src/agent/prompts/shared/24-canvas-tools.md` (mechanics only)
  - When to pose the canvas tool: derivations, proofs, diagrams, multi-step calculations.
  - Submissions arrive repeatedly. Coach between them and call `grade` to close.
  - How to read the grid and the `oN` ids.
  - Typed objects arrive verbatim as structured text.
- Modify: `src/agent/prompts/practice/00-base.md` (`canvas` on `problem`)
- Fixtures: run `npm run dev` against a scratch `data/`. Pose a `work` and submit twice (once with a drawing), dismiss a second `work`, then copy the record into `tests/fixtures/golden-data/chats/` unchanged, along with its `data/drawings/<chatId>/` folder. Press Hint once. Add `"work-submission"`, `"work-dismissed"` and `"hint-request"` to `EXPECTED`.
- [ ] **Step 1:** Write the fragment, then regenerate the fixtures. Run `NODE_ENV=test npx tsx --test tests/golden-fixtures.test.ts` and expect PASS.
- [ ] **Step 2:** Run the full gate. Expect clean.
- [ ] **Step 3:** Commit, open the PR, merge it, then release and deploy (minor bump). On VM 104, run one canvas task with a multimodal model and one with a text-only model.

---

## PR 3: teacher ink

### Task 14: `annotate` tool and derived annotations

**Files:**
- Modify: `src/core/canvas-core.ts`:
  ```ts
  type AnnotationTarget = { object: string } | { cell: string } | { cells: string }; // "B2:D3"
  type AnnotationMark = { kind: "circle" | "underline" | "check" | "cross" | "note"; target: AnnotationTarget; label?: string }
  	| { kind: "arrow"; from: AnnotationTarget; to: AnnotationTarget; label?: string };
  ```
  - `annotationMarkProblems(mark, scene, box): string[]` (an unknown object id or a cell outside the grid is a problem)
  - `resolveTargetRect(target, scene, box): Box | null` (world space)
  - `annotationsOf(messages, drawingId): { callId: string; marks: AnnotationMark[] }[]`, derived from successful `annotate` calls; failed calls are ignored
- Create: `src/agent/tools/annotate.ts`
  - `annotateToolFor({ chatId, drawingStore })` with input `{ drawingId, marks: AnnotationMark[] (1..20) }`
  - validates that the drawing belongs to the chat, and every mark against that drawing's scene and its `sceneBoundingBox`
  - returns `toToolResult("Annotated <n> marks.")` (non-terminating)
- Modify: `src/agent/tools.ts`, `src/agent/tools/practice.ts` (register when `canvas === true` or the record has any drawing reference)
- Modify: `src/agent/tools/heal.ts` if needed (an `annotate` argument whose `marks` arrives as a JSON string, like options)
- Test: `tests/annotate.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces: `annotationsOf`, `resolveTargetRect`, the `annotate` tool.

- [ ] **Step 1: Failing tests:**
  - `annotate rejects unknown object id`.
  - `annotate rejects out-of-grid cell` (`"Z99"`).
  - `annotate accepts cell range`.
  - `annotationsOf derives marks from record only`: deleting the drawing files does not change the derived marks.
  - `annotate on another chat's drawing refused`.
  - `resolveTargetRect cell range spans cells`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(agent): annotate tool with object/grid anchoring`

### Task 15: Ink layer UI and prompt

**Files:**
- Create: `components/canvas/teacher-ink.tsx` (`TeacherInk({ marks, scene, box, space: "world" | "percent" })`; circle = an ellipse around the rect, underline = the bottom edge, check/cross = glyphs at the top-right, note = a badge with the label, arrow = rect centre to rect centre; red ink colour token)
- Modify: `components/canvas/canvas-workspace.tsx` (a "Teacher marks" toggle; marks from `annotationsOf` over the session messages for every `drawingId` submitted on this call, mapped onto the live scene by object id or cell)
- Modify: `components/work-cards.tsx`, `components/practice-cards.tsx` (thumbnail overlay in percent space)
- Create: `components/artifacts/annotate-card.tsx`; register it in `components/artifacts/index.ts`
- Modify: `src/agent/prompts/shared/24-canvas-tools.md` (a section on `annotate`: prefer object ids; use a cell range for ink; keep it to a few marks; annotate before `grade` in the same turn)
- Test: `tests/render-canvas.test.tsx` (extend: `TeacherInk renders a circle for an object target`, `AnnotateCard lists marks`)
- [ ] **Steps 1–4:** Write the tests and watch them fail, implement, then watch them pass.
- [ ] **Step 5:** Commit, open the PR, merge it, then release and deploy.

---

## PR 4: advanced formats

### Task 16: Specs and graders for the remaining eight formats

**Files:**
- Modify: `src/core/exercise-core.ts` (add to `IMPLEMENTED_FORMATS`); create `src/core/automata.ts` for `graph`
- Test: `tests/exercise-core-advanced.test.ts`, `tests/automata.test.ts`

**Interfaces (spec → response; scoring):**
- `ordering` `{ items: { id: string; label: string }[]; order: string[] }` → `{ order: string[] }`. Ids absent from `order` are distractors; earned = slots matching by position minus 1 per placed distractor (floor 0); total = `order.length`. Items are shown in `seededRandom(toolCallId)` order.
- `matching` `{ left: { id; label }[]; right: { id; label }[]; pairs: [string, string][] }` → `{ pairs: Record<string,string> }`. Scored per left item; the right column is shown seeded-shuffled.
- `multipart` widens its part formats to every implemented format except `multipart` and `code`.
- `spot-error` `{ lines: string[]; wrong: number[]; fixes?: Record<string, { accept: string[]; mode?: "text"|"expression" }> }` → `{ picked: number[]; fixes?: Record<string,string> }`. `earned` = correct picks − false picks (floor 0) + correct fixes; `total` = `wrong.length + Object.keys(fixes ?? {}).length`.
- `fields` `{ fields: { id: string; label: string; bits: number; answer: string; given?: boolean }[] }` → `{ values: Record<string,string> }`. Each value is parsed as `0b`, `0x`, decimal, or a dotted quad when `bits === 32`, compared as a `BigInt` masked to `bits`.
- `sequence` `{ actors: string[]; messages: { id: string; label: string }[]; answer: { from: string; to: string; message: string }[] }` → `{ arrows: { from; to; message }[] }`. Scored per position.
- `plot` `{ axes: { x: [number, number]; y: [number, number] }; targets: ({ kind: "point"; x; y } | { kind: "line"; m; b })[]; tolerance: number }` → `{ points: [number, number][]; lines?: { m; b }[] }`. Each target is matched to its nearest response; a match within tolerance scores.
- `label` `{ svg: string; hotspots: { id: string; x: number; y: number }[]; labels: { id: string; text: string }[]; answer: Record<string, string> }` → `{ placed: Record<string,string> }`. `svg` is sanitised by `sanitizeSvg` (only shape/text/path/g elements; no `script`, `on*`, `href` or `foreignObject`). Scored per hotspot.
- `graph` `{ kind: "dfa"|"nfa"; alphabet: string[]; answer: Automaton } | { kind: "directed"|"undirected"; answer: { nodes: string[]; edges: [string, string, string?][] } }` → `{ automaton }` or `{ nodes, edges }`. Automata: `equivalent(a, b): { equal: true } | { equal: false; counterexample: string }` (subset construction, then a BFS over the product; shortest witness). Graphs: edge-set equality up to node relabelling, using bounded backtracking isomorphism with node count at most 12; over 12 nodes, nodes are compared by exact name. All-or-nothing, and the summary carries the counterexample.

- [ ] **Step 1: Failing tests** (one per format; these names are pinned):
  - `fields parses 0x/0b/dotted-quad and masks`: `"0xFF"` with bits 4 gives `0xF`; `"192.168.0.1"` equals `3232235521`.
  - `automata counterexample is shortest`: `(ab)*` vs `(ab)*a?` gives `"a"`.
  - `nfa with epsilon equals its dfa`.
  - `isomorphic graphs with renamed nodes are equal`.
  - `spot-error false picks cost points`.
  - `ordering scores per slot and penalises distractors`.
  - `matching per left item`.
  - `sanitizeSvg strips script and handlers`.
  - `display order is seeded`.
- [ ] **Steps 2–4:** Watch them fail, implement, then watch them pass.
- [ ] **Step 5:** Commit `feat(core): advanced exercise formats`

### Task 17: Widgets for the eight formats

**Files:**
- Create: `components/exercise/{ordering,matching,spot-error,fields,sequence,plot,label,graph}-widget.tsx` (ordering: drag on pointer plus Alt+↑/↓; matching: a select menu per left row) (graph: click to add a node, drag between nodes to add an edge, accepting/start toggles for automata; plot: tap to place a point, two taps for a line; label: drag a chip onto a hotspot, or tap the chip and then the hotspot)
- Modify: `src/agent/prompts/shared/22-exercise-tools.md` (spec fields for the eight)
- Modify: `components/settings/agent-section.tsx`, which lists `IMPLEMENTED_FORMATS` automatically
- Test: `tests/render-exercise.test.tsx` (extend: an input render and a review render per format)
- [ ] **Steps 1–4:** Write the tests and watch them fail, implement, then watch them pass.
- [ ] **Step 5:** Commit, open the PR, merge it, then release and deploy. Manual check in a dev session: the agent authors one of each, and you answer them on desktop and on a phone.

---

## PR 5: `code` format with self-hosted runtimes

### Task 18: Spike, then vendor the runtimes

**Files:**
- Modify: `package.json` (devDependencies `pyodide`, `@yowasp/clang`, `@bjorn3/browser_wasi_shim` at exact versions; script `"vendor:runtimes": "node scripts/vendor-runtimes.mjs"`, run from `prebuild` and `predev`)
- Create: `scripts/vendor-runtimes.mjs` (copies the browser-loadable files of each package into `public/runtimes/<pkg>-<version>/`; idempotent; writes `public/runtimes/manifest.json` `{ pyodide: "<path>", clang: "<path>", wasiShim: "<path>" }`)
- Modify: `.gitignore` (`public/runtimes/`)
- Modify: `next.config.ts` (read `node_modules/next/dist/docs/` on `headers()` first; set `/runtimes/:path*` to `Cache-Control: public, max-age=31536000, immutable`)
- Modify: `scripts/build-server.mjs` (fail when `public/runtimes/manifest.json` is missing from the standalone payload)

- [ ] **Step 1 (spike, stop gate):** On a throwaway page under `npm run dev`, load each runtime from `/runtimes/...` inside a module Worker:
  - run `print(1+1)` in Pyodide;
  - compile and run `int main(){puts("ok");}` with clang at `-std=c++20`.

  Record the load time and transfer size. **If clang cannot run in a browser Worker from static files, stop and ask the owner** whether to ship JS + Python only.
- [ ] **Step 2:** Implement the vendor script and the headers. Run `npm run build && node scripts/build-server.mjs` and expect the manifest in `.next/standalone/public/runtimes/`.
- [ ] **Step 3:** Run `docker build -t learnharness:local .` and expect success. Record the image size delta in the PR description.
- [ ] **Step 4:** Commit `build: vendor pyodide and clang runtimes into public/runtimes`

### Task 19: Code runner, `code` format, widget

**Files:**
- Modify: `src/core/exercise-core.ts`:
  - spec `CodeSpec { language: "javascript"|"python"|"cpp"; starter: string; harness?: string; tests: { id: string; input: string; expected: string }[]; timeoutMs?: number }` (default `timeoutMs` 5000, at most 20 000, at most 30 tests)
  - response `{ code: string; results: { id: string; passed: boolean; actual?: string; error?: string }[] }`
  - the grader requires exactly one result per test id; `earned` = passed count
- Create: `components/exercise/code-runner.ts` (`runTests(spec, code): Promise<CodeResult[]>`)
  - one Worker per run, terminated on timeout
  - JS runs in a sandboxed `srcdoc` iframe (`sandbox="allow-scripts"`, no same-origin: the demo precedent in docs/vision.md) with a CSP meta `default-src 'none'; script-src 'unsafe-inline'`; on timeout the iframe is removed
  - Python and C++ run in a same-origin module Worker (they must fetch `/runtimes` through the auth proxy). After the runtime loads and before any learner or agent code runs, the worker deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `importScripts` from its scope.
  - Python and C++ load from the URLs in `/runtimes/manifest.json`
  - each test feeds `input` on stdin and compares trimmed stdout with `expected`
- Create: `components/exercise/code-widget.tsx` (a plain `<textarea>` editor with tab indentation, a "Run tests" button, and the per-test result list; submit sends the code and the last results)
- Modify: `src/agent/prompts/shared/22-exercise-tools.md` (code spec fields; stdin/stdout contract)
- Test: `tests/exercise-code.test.ts`:
  - `code grader requires every test id`.
  - `code grader counts passes`.
  - `timeoutMs clamped`.
  - `tests/render-exercise.test.tsx`: `code widget renders starter`.
- [ ] **Steps 1–4:** Write the tests and watch them fail, implement, then watch them pass.
- [ ] **Step 5:** Run the full gate including the docker build. Commit, open the PR, merge it, then release and deploy. Manual check on VM 104 behind the auth proxy: one JS, one Python and one C++ exercise run, and the second load comes from the browser cache.
