# Canvas Session Tutor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canvas turns run on the session's own model. A vision reader always describes each submitted drawing, every submission reply marks the drawing (code-enforced once), internal rung labels never reach the learner, and teacher marks render as a readable red-pen hand (Shantell Sans).

**Architecture:**
- **Routing and settings.** Remove the canvas-model routing and the `models.canvas` slot end to end.
- **Reader.** `prepareDrawingContext` always transcribes the newest active drawing, and `toLlmMessages` sends the transcript alongside the image.
- **Mark guard.** A new turn-nudge predicate steers once when a drawn submission ends unmarked.
- **Label strip.** A pure core strip function runs at the two read seams (`projectView` for the learner, `toLlmMessages` for the model).
- **Ink.** `TeacherInk` is restyled.

**Tech Stack:** Next.js 16, TypeScript strict, pi-ai/pi-agent-core, node:test via tsx, `next/font/google`.

**Spec:** `docs/superpowers/specs/2026-10-28-canvas-session-tutor-design.md`

## Global Constraints

- Node 26. Run `source ~/.nvm/nvm.sh && nvm use 26` before any npm/npx command.
- Import law (lint-enforced): `components/` import only `@/src/core`; `app/` imports only the core and server barrels. Relative imports use explicit `.ts` extensions; `import type` for types.
- Every task ends with `npm run typecheck`, `npm test`, `npm run lint` clean. The final task also runs `npm run build`.
- No on-disk format change. `tests/fixtures/golden-data/` stays untouched, and `tests/golden-fixtures.test.ts` must stay green.
- The record stays raw. Label stripping happens at read time only, and the persisted record is the only source of truth.
- **Side-channel law:** a reader failure never fails the turn.
- **Commit trailer:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LhT9Ki7YEPmfjxRsD5gqyT
  ```
- Learner-facing marks: red (`TEACHER_INK_COLOR`, palette `red`) for circle, underline, cross, arrow and standalone note; green (palette `green`) for check. A mark's label takes its mark's colour.

## Review Focus

1. **A settings file that already holds `models.canvas`** (the owner's live server has one) must load, and saving Settings → Models must not be rejected with "unknown slot". Pinned in Task 1 (`parseModelsSettingsBody` drops `canvas`).
2. **A legitimate "(R1 …)" in course content**, e.g. register R1 in a CS lesson, could be stripped. The strip only removes a parenthetical that *starts* with `R0`–`R5` followed by `:` or `)`, or that starts with `rung`/`Rang`/`Stufe`. Pinned in Task 4 with a negative case ("register (R1) holds", "R1 = 5" stay).
3. **A drawn submission whose drawing is empty**: `annotate` refuses, and the steer must still fire at most once per turn. Pinned in Task 3.
4. **A text-only session model with no vision slot configured**: the canvas still works from the structured text with the "transcription unavailable" line. Pinned in Task 2 (existing test kept green).
5. **Long notes on a phone-width thumbnail** must stay inside the drawing box and readable. Task 5 wraps notes to at most two lines and keeps the full text in `<title>`.

---

### Task 1: Session model runs canvas turns; the canvas slot is removed

**Files:**
- Modify: `src/server/chat-handler.ts:395-415,466-500` (drop `resolveCanvasModel`, `canvasEngine`, the `isCanvasInput` switch; `canvas` gate; `drawingStore` always passed)
- Modify: `src/core/settings.ts:71-120,250-258` (`MODEL_SLOTS = ["strong","cheap","vision"]`; delete `CanvasVettedModel`, `CANVAS_VETTED_MODELS`, `CANVAS_DEFAULT_MODEL`, `isCanvasVetted`, `ModelsSettings.canvas`)
- Modify: `src/core/settings-resolution.ts:174-194,245-247` (delete `resolveCanvasModel` and `models.canvas`)
- Modify: `src/core/input-events.ts:383` (delete `isCanvasInput` if no other caller remains)
- Modify: `src/server/settings-body.ts:375-405` (drop the canvas allowlist branch; silently drop a legacy `canvas` key)
- Modify: `src/server/model-catalog.ts:35,195-210` (delete `catalogCanvas` and the `canvas` response field and its type)
- Modify: `components/settings/agent-section.tsx` (delete the Canvas slot row, `canvasInForce`, the `isCanvasVetted` filter)
- Modify: `components/model-picker.tsx:425-480` (delete `CANVAS_UNAVAILABLE`, the `available` prop and the disabled branch of `CanvasPill`)
- Modify: `docs/architecture.md:365,380` (replace the canvas-model bullet with one line: canvas turns run on the session model; the tools exist when `settings.canvas` and `canvasCapable`)
- Test: `tests/canvas-model.test.ts` (rewrite), `tests/settings-resolution.test.ts`, `tests/settings-body.test.ts`, `tests/model-catalog.test.ts`, `tests/render-canvas.test.tsx`, `tests/render-settings.test.tsx`, `tests/esc-layering.test.ts` (remove canvas-slot cases)

**Interfaces:**
- Produces: in `handleChatInput`, `const canvas = record.settings?.canvas === true && turnOpts.canvasCapable === true;` and every turn's `engine` is `conversationEngine`. `ModelSlotName` is `"strong" | "cheap" | "vision"`. `CanvasPill` props are `{ chatId?, value?, onChange?, capable? }`.

- [ ] **Step 1: Rewrite `tests/canvas-model.test.ts`.** Keep its harness (`chatWith`, `turn`). Replace the describes with:

```ts
describe("canvas turns run on the session model", () => {
	it("a work submission and a hint run on the chat's model", async () => {
		const chat = chatWith(pose());
		assert.equal((await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "x" })).modelId, TUTOR.id);
		assert.equal((await turn(chat.id, { type: "hint", callId: "w1" })).modelId, TUTOR.id);
	});
	it("switching the chat's model moves the canvas turns with it", async () => {
		const chat = chatWith(pose(), { model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" } });
		assert.equal((await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "x" })).modelId, "deepseek/deepseek-v4.1-flash");
	});
});
describe("canvas tools follow the setting and the device only", () => {
	it("any model gets the canvas when the setting is on and the device can draw", async () => {
		// the old "no OpenRouter key + openai gpt-4" case, now asserting canvas === true and modelId "gpt-4"
	});
	it("a phone turn (not canvas-capable) registers no canvas", async () => {
		const chat = chatWith(pose());
		assert.equal((await turn(chat.id, { type: "text", text: "hi" }, false)).canvas, false);
	});
});
```

- [ ] **Step 2: Add a settings-body test** in `tests/settings-body.test.ts`:

```ts
it("a legacy canvas slot is dropped, not rejected", () => {
	const r = parseModelsSettingsBody({ strong: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } }, canvas: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } } });
	assert.equal(r.ok, true);
	assert.deepEqual(Object.keys(r.ok ? r.settings : {}), ["strong"]);
});
```

  Delete the canvas-allowlist cases there, the `resolveCanvasModel` describe in `tests/settings-resolution.test.ts`, and the `canvas` assertions in `tests/model-catalog.test.ts`, `tests/render-settings.test.tsx`, `tests/render-canvas.test.tsx` (disabled-pill case) and `tests/esc-layering.test.ts`.

- [ ] **Step 3: Run the two tests and confirm they fail.** Run `NODE_ENV=test npx tsx --test tests/canvas-model.test.ts tests/settings-body.test.ts`. Expected: FAIL. The submission runs on `z-ai/glm-5.3-flash`, and "unknown slot" does not apply yet, but the canvas key is rejected as not allowlisted.

- [ ] **Step 4: Implement the removals listed under Files.** In `parseModelsSettingsBody`, `if (key === "canvas") continue;` comes before the unknown-slot check, with a one-line comment: legacy slot from 0.26.x, ignored. Remove `canvasModel` from the `drawingStore` spread in the practice branch, so `drawingStore: stores.drawingStore` is passed unconditionally (the teacher and prober branches likewise). Grep afterwards for `canvasModel|resolveCanvasModel|isCanvasVetted|CANVAS_VETTED|CANVAS_DEFAULT|catalogCanvas|CANVAS_UNAVAILABLE|isCanvasInput`. Expected: no hits outside `docs/superpowers/` and the CHANGELOG.

- [ ] **Step 5: Run the full gates.** Run `npm run typecheck && npm test && npm run lint`. Expected: all pass.

- [ ] **Step 6: Commit** with `feat(canvas)!: canvas turns run on the session model; the canvas model slot is removed`.

---

### Task 2: The reader always transcribes; vision tutors get the picture and the transcript

**Files:**
- Modify: `src/server/drawing-context.ts:49-100` (transcribe regardless of `modelReadsImages`; `resolve` returns `{ png?, transcript?, structured }`)
- Modify: `src/core/native-messages.ts:938-945` (`drawingMessage`: with a png, the text part carries `Transcription:\n<t>` before the structured text when a transcript exists)
- Modify: the file header comments of both to say the reader always runs
- Test: `tests/drawing-context.test.ts`

**Interfaces:**
- Consumes: `DrawingContext.resolve` (unchanged shape).
- Produces: for a multimodal engine, `resolve(id)` returns both `png` and `transcript` when the transcriber succeeds.

- [ ] **Step 1: Replace the test `active drawing sent as image to multimodal model`** with `multimodal model gets the image AND the reader's transcript`. Use the file's existing fake transcriber and stores. Assert:
  - `resolve(newest).png` is defined;
  - `resolve(newest).transcript === "<fake transcript>"`;
  - the converted user message (via `toLlmMessages(..., { drawing })`) has an `image` part, and its text part contains both `Transcription:` and the structured text.

  Add `transcriber failure keeps the image`. The transcriber throws; assert `png` is defined, `transcript` is undefined, and nothing throws.

  Keep `transcription usage is reported once (cache hit reports none)` and run it for a multimodal engine too, with one more `it` using the vision engine fixture.

- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/drawing-context.test.ts`. Expected: the new cases FAIL (no transcript for multimodal).

- [ ] **Step 3: Implement.** Drop the `if (!modelReadsImages)` guard around the transcription block. In `resolve`, attach `transcript: transcripts.get(drawingId)` (when present) in both branches. In `drawingMessage`, the png branch text becomes `${marker.content}\n${GRID_NOTE}${transcript ? `\nTranscription:\n${transcript}` : ""}${structured}`.

- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run lint`. Expected: pass. `compaction estimate counts the image` may need the transcript text counted: update its expected number only if the estimate legitimately grew, and say so in the commit body.

- [ ] **Step 5: Commit** with `feat(canvas): the reader always describes a submitted drawing, beside the image for vision tutors`.

---

### Task 3: Every drawn submission gets marked (prompt rule and a one-time steer)

**Files:**
- Modify: `src/agent/turn-nudge.ts` (add `MARK_STEER`, `unmarkedSubmission`, and wire both into `nextNudge`)
- Modify: `src/agent/prompts/shared/24-canvas-tools.md` §"Marking a drawing"
- Test: create `tests/turn-nudge.test.ts`

**Interfaces:**
- Produces: `export function unmarkedSubmission(messages: readonly LhMessage[]): string | undefined`. It returns the drawing id when the input boundary is a `work-submission` or `practice-thinking` marker whose `details.drawingId` is a string, and no `toolResult` with `toolName === "annotate"` and `!isError` follows the boundary; otherwise `undefined`. Also `export const markSteer = (drawingId: string) => string`.
- `nextNudge` precedence: `unmarkedSubmission` first (its steer also asks for the plain-text reply, so it covers `silentAfterSubmission` too), then `silentAfterSubmission`, then `planWrittenAsProse`. Still at most one steer per turn.

- [ ] **Step 1: Write `tests/turn-nudge.test.ts`.** Build records with `newWorkSubmission("w1", "x", "drw_1")` from `src/core/native-messages.ts` and the `call`/`result` helpers from `tests/learner-helpers.ts`:

```ts
it("a drawn submission with no annotate is unmarked", () => {
	assert.equal(unmarkedSubmission([...pose, newWorkSubmission("w1", "x", "drw_1"), assistantText("Look again at the bracket.")]), "drw_1");
});
it("a successful annotate marks it", () => {
	assert.equal(unmarkedSubmission([...pose, sub, call("a1", "annotate", { drawingId: "drw_1", marks: [] }), result("a1", "annotate", null)]), undefined);
});
it("a refused annotate does not count", () => { /* result with isError: true → "drw_1" */ });
it("a submission without a drawing and a hint request are exempt", () => { /* newWorkSubmission("w1","x") → undefined; hint-request boundary → undefined */ });
it("nextNudge steers once with the drawing id, then never again this turn", () => {
	const done = { used: false };
	assert.match(nextNudge(unmarked, done)!, /annotate/);
	assert.match(nextNudge(unmarked, done) ?? "", /^$/);
});
```

- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/turn-nudge.test.ts`. Expected: FAIL (`unmarkedSubmission` is not exported).

- [ ] **Step 3: Implement.** `markSteer(id)` must return exactly:

  > `You have not marked his drawing yet. Call annotate on drawing ${id}: a mark on the first place the work breaks, or a check on what holds. Then tell him in plain text what you saw and what to do next.`

  Reuse the module's `sinceInput` and `failedOutputCallIds`.

  In `24-canvas-tools.md`, replace the bullet "Mark what you are about to talk about: …" with:

  > `- Every reply to a submission with a drawing calls annotate before its prose: circle the first place the work breaks, check a step that holds. Keep it to a few marks; many marks bury the one that matters. It does not end your turn, and a refusal names the valid cells and ids, so correct and retry.`

- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run lint`. Expected: pass.

- [ ] **Step 5: Commit** with `feat(canvas): a drawn submission is always marked (prompt rule + one-time steer)`.

---

### Task 4: Internal rung labels never reach the learner

**Files:**
- Create: `src/core/internal-labels.ts` (export from `src/core/index.ts`)
- Modify: `src/core/view.ts:229,245` (text parts go through the strip)
- Modify: `src/core/native-messages.ts` `toLlmMessages` (assistant `text` blocks go through the strip), `:599-601` `hintRequestText`
- Modify: `src/agent/prompts/shared/24-canvas-tools.md` (hint bullet) and `src/agent/prompts/shared/40-formatting.md` (one rule)
- Test: create `tests/internal-labels.test.ts`; update any test pinning the old hint-request text (grep `give the next rung`)

**Interfaces:**
- Produces: `export function stripInternalLabels(text: string): string` (pure, idempotent).

- [ ] **Step 1: Write `tests/internal-labels.test.ts`** with the verbatim live and re-test strings:

```ts
const cases: Array<[string, string]> = [
	["**Hint 1 (rung: name the pattern).**\n\nLook only at the squared part.", "Look only at the squared part."],
	["**Hint 1 (Rang 1 — Muster benennen):**\n\nVerschieben tut nicht", "Verschieben tut nicht"],
	["**Hint 1 (R1):** The equation is a recipe", "The equation is a recipe"],
	["welche Regel liegt zugrunde? (R1: Das ist eine Bausteinkonstruktion, kein freies Aufzählen.)", "welche Regel liegt zugrunde?"],
];
it("strips rung headers and labels", () => { for (const [i, o] of cases) assert.equal(stripInternalLabels(i), o); });
it("keeps ordinary content", () => {
	for (const s of ["**Hint 1:** Forget the rules", "register (R1) holds the sum", "Let R1 = 5 ohm", "Stufe 2 der Treppe"]) assert.equal(stripInternalLabels(s), s);
});
it("is idempotent", () => { for (const [i] of cases) assert.equal(stripInternalLabels(stripInternalLabels(i)), stripInternalLabels(i)); });
```

  Also add one `projectView` assertion in the same file: an assistant text block `"**Hint 1 (R1):** Look"` projects to the text part `"Look"`.

- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/internal-labels.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `stripInternalLabels`.**
  - Rule (a), a leading header: optional `**`, `Hint`/`Tipp`/`Hinweis` with a number, then a parenthetical whose content starts with `R[0-5]\b`, `rung`, `Rang` or `Stufe`, then optional `.`/`:`, optional `**`, optional `:` and trailing whitespace or newlines. It is removed.
  - Rule (b), anywhere: whitespace followed by `(R[0-5](?::|\))…)` or `((?:rung|Rang|Stufe)\s*\d…)` up to the matching `)`. It is removed.
  - Both rules are case-insensitive except `R`.

  `hintRequestText(n)` returns `` `Hint request ${n} for this task — give the next, smallest hint only.` ``.

  Prompt line for both md files:

  > `Rung numbers and names are your internal scale: never write "rung", "R0"–"R5", "Rang", "Stufe" or a "Hint n (…)" header in anything he reads.`

- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run lint`. Expected: pass.

- [ ] **Step 5: Commit** with `feat(canvas): internal hint-rung labels are stripped from what the learner and the model read`.

---

### Task 5: Teacher ink in a readable red-pen hand (B2)

**Files:**
- Modify: `app/layout.tsx` (load `Shantell_Sans` from `next/font/google`: `{ subsets: ["latin"], weight: ["500"], variable: "--font-teacher-hand" }`, and add `.variable` to `<html>`)
- Modify: `components/canvas/teacher-ink.tsx` (hand-drawn paths, colour per kind, handwriting notes with a paper halo)
- Test: `tests/render-canvas.test.tsx`

**Interfaces:**
- Consumes: `AnnotationMark`, `resolveTargetRect` (unchanged), `screenColor`, `TEACHER_INK_COLOR`.
- Produces: `TeacherInk` props unchanged. The new exported pure helper is `export function wobblePath(points: Array<[number, number]>, seed: number, amp: number): string` (an SVG path `d`, deterministic for equal inputs).

- [ ] **Step 1: Write render tests** with `renderToStaticMarkup(<TeacherInk … space="percent" theme="light" />)`, one mark of each kind on a simple scene:
  - every kind renders its `data-mark`;
  - the `check` mark's stroke is `#15803d`, and every other kind's is `#d62828`;
  - a note and a label render `<text>` whose `font-family` contains `var(--font-teacher-hand)`, with `paint-order="stroke"` and a stroke equal to the paper colour;
  - a 60-character label renders two `<tspan>` lines at most, and `<title>` holds the full text;
  - rendering the same marks twice gives identical markup;
  - the circle is a `<path>` (no `<ellipse>`).

- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/render-canvas.test.tsx`. Expected: the new cases FAIL.

- [ ] **Step 3: Implement.**
  - `wobblePath` jitters each point by up to `amp` with a seeded PRNG (mulberry32 over `seed`) and joins the points with quadratic smoothing.
  - The seed is a string hash of `JSON.stringify(mark)` plus the mark index.
  - Circle: about 14 points on the ellipse that `circle` uses today, overshooting the start by about 25°.
  - Underline: 4 points. Arrow: a slightly curved line plus a two-stroke head.
  - Check and cross: today's glyphs, each point jittered.
  - `Badge` is replaced by `HandNote`:
    - Shantell Sans at today's badge size × 1.15;
    - a paper halo via `paint-order="stroke"` with a stroke width of `u*1.2`;
    - wrap at 24 chars into at most 2 `<tspan>` lines, and cut with `…` beyond that;
    - clamped inside `minX..maxX` as today.
  - Colour: `screenColor(mark.kind === "check" ? "green" : TEACHER_INK_COLOR, theme)`.

- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run lint && npm run build`. Expected: pass. The build fetches the font at build time, as Source Sans 3 already does.

- [ ] **Step 5: Commit** with `feat(canvas): teacher marks in a readable red-pen hand (Shantell Sans)`.

---

### Task 6: Live verification, release and deploy

**Files:**
- Modify: `package.json` / `package-lock.json` version → `0.27.0`; `CHANGELOG.md` if present (follow the 0.26.x entries)

- [ ] **Step 1: Live check on a scratch server.**
  - Port 3030, `LH_DATA_DIR` = a copy of `tests/fixtures/golden-data`, `LH_AUTH_FILE=/home/test/.config/learnharness/dev-auth.json`, `LH_PROVIDER_EVENTS=1`.
  - Models: session model `openrouter deepseek/deepseek-v4.1-flash`, and the vision slot on a cheap image-capable OpenRouter model from the catalog. The owner's standing rule is no Sonnet/Opus test spend; the mechanics under test are model-independent. Cap: $0.50.
  - Reuse the driver from `/tmp/claude-1002/-home-test-learnharness-learnharness/b1ac23c0-2778-41a8-a85b-9a0a7051bd81/scratchpad/mimo2/run.mts` and its drawings. Run English and German: wrong submission, then hint, then corrected submission.
  - **Pass means:**
    - every submission turn's model is the session model;
    - the reader ran (a transcript is cached for each drawing);
    - each submission reply has a successful `annotate` (steered or not, say which);
    - no projected text part contains a rung label or CJK;
    - no give-away;
    - the grade closes on the correct drawing.
  - Take Playwright screenshots of the marked drawing at 390px and desktop width.
  - Kill the server by PID (`ss -ltnp | grep :3030`), never `pkill -f`.

- [ ] **Step 2: Bump to 0.27.0, push the branch, open the PR and merge it** (release flow: merge without waiting for CI). Then tag `v0.27.0`, create the GitHub release, and deploy with `ssh root@learnharness.fritz.box systemctl restart learnharness-stack`.

- [ ] **Step 3: Confirm the live server runs 0.27.0** and still loads the owner's settings file. It holds a `models.canvas` key: confirm `GET /api/settings` and a Settings → Models save both succeed.
