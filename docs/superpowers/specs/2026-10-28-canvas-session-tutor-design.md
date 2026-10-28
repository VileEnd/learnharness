# Canvas tutoring by the session model — design

Date: 2026-10-28. Status: draft for owner approval.

## Why

In the owner's live session on 0.26.2 (chat `chat_mvs4g5t2_110600b9`, a German Theoretische-Informatik session on Sonnet 5.5), the canvas task was taken over by the canvas slot's model (GLM 5.3 Flash), and the owner saw:

- no correction marks on the drawing: `annotate` was armed but never called;
- Chinese characters mid-sentence in a hint ("welche Regel liegt dem整个过程 zugrunde");
- an internal rung label in visible prose ("(R1: …)");
- coaching that drew half the answer (the tree down to length 2).

A re-test of MiMo-V2.6 Flash on 0.26.2 (scratchpad `mimo2/`, $0.04) read drawings correctly now. But it skipped `annotate` on 2 of 3 coached wrong submissions, leaked rung labels in 2 of 3 hints ("Hint 1 (Rang 1 — Muster benennen)"), and gave the move away in a German hint. Two of these causes are in the app, not the model:

- the prompt makes marking mandatory only on close;
- the hint-request message itself says "give the next rung only", and nothing forbids writing rung labels.

The owner's model of the canvas: **a reader turns the canvas into content, the tutor (the model the owner picked) does the feedback, and the feedback lands as readable handwriting in the right places on the canvas.** Today the cheap canvas model does all three, and the owner's chosen tutor sits idle.

## Goals

1. Every turn of a canvas task (posing, each submission, each hint, the grade) runs on the **session's own model**: the per-chat model, else the strong slot. The owner's words: "if I choose another model as teacher, it's this model."
2. Each submission is first read by a **reader**: a single vision call that turns the drawing into a description. The tutor always gets that description. If the tutor can see images, it also gets the picture.
3. Every reply to a submission, coaching or closing, puts **marks on the drawing** at the places the tutor names. Code draws them.
4. Marks look like a teacher's red pen, and notes are written in a **clearly readable marker hand**. The owner chose mockup "B2" (Shantell Sans): wobbly pen strokes, plus a paper-coloured outline behind the letters so notes stay readable over the learner's strokes.
5. No internal labels (rung numbers or names, "Hint n (…)" headers) ever reach the learner.

## Non-goals

- The model picker's "recommended & cheapest" group and the monthly cost counter. These are a separate project (worktree `cost-and-picks`), brainstormed next.
- A separate placement model. The owner decided: the tutor names the spots, and code draws.
- Changing how a canvas task is posed, graded or hinted (the doctrine in `24-canvas-tools.md` stays), apart from the marking and label rules below.
- Freeform note placement by eye (notes beside a stroke rather than anchored to it).

## Anti-goals (a failure even if it works)

- A mark that lands somewhere other than where the tutor meant.
- A note the learner cannot read: too small, too scripty, or lost on top of their own strokes.
- Any canvas reply in another language or script than the session's, or carrying internal vocabulary.
- A canvas turn running on a model the owner did not pick.

## How it works (decided)

### Turn routing
- Remove the canvas-model routing in `src/server/chat-handler.ts` (`resolveCanvasModel`, `canvasEngine`, `isCanvasInput` engine switch). Canvas-input turns use `conversationEngine`, like every other turn.
- The canvas tools are armed when `record.settings.canvas === true` and the request is `canvasCapable`. The "vetted canvas model" condition goes away. `annotate` is armed whenever the drawing store is present (`annotateToolsFor`'s existing rule), with no canvas-model condition.

### The reader
- On a submission turn, the newest active drawing is **always** transcribed by the existing drawing transcriber (`src/agent/subagents/drawing-transcriber.ts`, vision slot, one call, cached per drawing via `drawingStore.writeTranscript`). Today it runs only when the tutor cannot read images.
- `prepareDrawingContext` (`src/server/drawing-context.ts`) gives the tutor three things:
  - the transcript;
  - the code-computed structured text (object ids, stroke digest with grid-unit extents) as today;
  - the PNG, when the tutor's model has image input.
- **Failure:** no vision slot, no key, or the call fails. The turn proceeds without a transcript, as today: image plus structured text for a vision tutor, structured text alone otherwise, with the existing "transcription unavailable" note. A reader failure never fails the turn (the side-channel law).
- The reader's spend goes through the existing `onUsage` money channel, as today.

### Marking
- The `annotate` tool and its anchors (object id, stroke id, cell, range; arrow `from`/`to`) are unchanged. The prompt rule changes from "mark what you are about to talk about" (soft) to: **every reply to a work submission calls `annotate` before its prose, with at least one mark on the first place the work breaks, or a check on what holds when it is right.**
- **Code guard:** if the turn's triggering input is a work submission and the turn ends without a successful `annotate` call, the turn is steered once with a short system nudge to mark the drawing. This follows the precedent of `grade.ts` refusing a grade inside a hint turn and the loop breaker in `turn-guard.ts`. Hint turns are exempt: no new drawing.

### Rendering the marks (B2)
- `components/canvas/teacher-ink.tsx` draws every mark in the red-pen style. That covers both places marks show today: the drawing thumbnail in the chat (`work-cards.tsx`) and the open canvas workspace.
  - Circle and underline: a slightly irregular hand-drawn path around the target's box, deterministic per mark (seeded by drawing id plus mark index, so a re-render never wobbles).
  - Check and cross: pen strokes.
  - Arrow: a curved pen stroke with a hand-drawn head.
  - Note and every `label`: text in Shantell Sans, sized for legibility, with a paper-coloured stroke outline behind the glyphs.
- **Colour:** red for circle, underline, cross and arrow; green for check. The colour of a note follows the mark it belongs to, and a standalone note is red.
- **Font:** Shantell Sans is self-hosted (no runtime Google Fonts call; the app is self-hosted and its CSP should not grow).

### No internal labels
- `hintRequestText(n)` (`src/core/native-messages.ts`) drops the word "rung": "Hint request n for this task — give the next, smallest hint only."
- The canvas and formatting prompts say rung numbers and names are an internal scale and never appear in visible text.
- **Code backstop:** a leading `**Hint n (…)**`-style header, or a parenthesised `R0`–`R5` / `rung` / `Rang` / `Stufe` label, is stripped from visible assistant text at the stream boundary.

### The canvas model slot
- Remove the canvas slot from settings:
  - `src/core/settings.ts`: `CANVAS_VETTED_MODELS`, `CANVAS_DEFAULT_MODEL`, `isCanvasVetted`;
  - `src/core/settings-resolution.ts`;
  - `src/server/settings-body.ts`;
  - `src/server/model-catalog.ts`;
  - the canvas pill and slot UI (`components/settings/agent-section.tsx`, `components/model-picker.tsx` `CanvasPill`).
- Existing settings files that still carry the slot are read without error and the field is ignored. This is not a schema version bump.

## Cost (owner accepted)

Canvas turns are billed at the session model's price; with Sonnet 5.5 that is well above GLM's ~$0.10 per session. Each submission adds one reader call on the vision slot.

## Left to the builder

- The exact wording of the prompt changes (keep them short; the rule text above is the intent).
- The guard's nudge text, and how it reuses the existing steer and loop-breaker machinery.
- The hand-drawn path generation (any deterministic jitter that reads as a pen).
- Font sizes and the outline width, within "clearly readable on a phone".
- Test shapes, following the repo's test law: faux provider, `renderToStaticMarkup`, the simplest proof.
- Golden fixtures: only if an on-disk format changes. None is intended.

## Verification

- **Unit/render tests:**
  - routing: a canvas-input turn uses the conversation engine;
  - the reader runs for a vision tutor and its transcript reaches the context;
  - the guard steers once when a submission turn has no `annotate`;
  - label stripping;
  - teacher-ink renders each mark kind.
- **A live check** on a scratch server with the owner's real model choice (Sonnet 5.5), English and German: wrong submission, then hint, then corrected submission. Pass means:
  - marks appear on every submission reply;
  - no labels and no foreign script;
  - no give-away;
  - the hint is rung-true;
  - the grade closes on the correct drawing.

  Screenshots of the marks on phone and desktop width go to the owner.
