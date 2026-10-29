# Cost counter and request log, recommended models, note placement: design

Date: 2026-10-29. Status: draft for owner approval. Three independent parts, shipped together.

---

## Part A: Request log and cost counter

### Why
The owner wants to see what LearnHarness costs per month, from a glance at the top right down to a breakdown, with graphs and failed requests in Settings. They also want logs we can read together when something breaks.

Today the home pill shows graph-pipeline spend only. Several kinds of spend are recorded nowhere:
- sync/concept/query embeddings;
- the batch-embedding cost (it is console-logged only);
- topic naming, the document describer, learner-model attribution;
- retries that `withEmptyErrorRetry` swallows;
- failed calls.

Deleting a chat also deletes its turns, extractions and jobs, so any total derived from chat records shrinks after the fact. Errors exist only in Docker stdout.

### Owner decisions
- **Top right:** this month's total, always visible. Clicking it shows the breakdown. A Settings page shows the graphs and the failed requests.
- **What the log stores for every call:** metadata only, plus the error text for failures:
  - time, purpose, model, tokens, cost, duration, outcome, error text, chat id.
  - No prompts and no answers: no lecture text in the log.
- **Debugging together:** Claude reads the same log on the server over SSH.

### Goals
1. **A request log.** One append-only line per outbound paid call, written as the call ends (success, error or abort), in `data/logs/requests-YYYY-MM.jsonl`, one file per month.
2. **The monthly total** comes from the log. Dollars are inferred at read time from tokens plus the model, through the existing `callCost` (the money-channel law). The only stored dollars are provider-reported ones for calls pi's catalog cannot price: OCR's `cost_usd`, the batch-embedding `usage.cost`, and OpenRouter's reported cost on sync `/embeddings` responses (embedding models are not in pi's catalog). *(My call: without it, Library spend would almost all show "—".)* A line that cannot be priced counts as unpriced and renders "—", never $0.
3. **Partial totals.** When some calls in the month are unpriced, the pill still shows the priced total. The panel and Settings say "N calls unpriced" next to the total, so a partial number never looks complete. *(My call.)*
4. **Top-right pill.** On both home variants (graph view and minimal home), in the place the graph cost pill uses today, always shown: "This month $x.xx". It shows "—" only when nothing in the month is priced.
5. **Click opens a panel** with:
   - this month's total;
   - the split by category;
   - the number of sessions with spend this month;
   - the five most expensive sessions of the month, each linking to its chat;
   - the count of failed requests this month, linking to Settings → Usage.
6. **Settings → Usage**, a new read-only section with:
   - a month picker (the last 12 months that have data);
   - a **daily spend bar chart** for the selected month, stacked by category;
   - a **12-month bar chart** of monthly totals;
   - the category table (dollars, calls, tokens, unpriced calls);
   - the **per-session table** (title, kind, dollars, calls);
   - the **failed requests list**: time, purpose, model, error text, chat link; newest first, paged by 50.
7. **Backfill so this month is right on day one.**
   - On first start with no log, the existing records are imported once as `imported: true` lines at their own timestamps: chat turns, extraction runs, jobs, OCR costs on documents.
   - Imported lines carry what the record has (model, tokens and time; no duration or error).
   - The backfill never runs again (a marker file). Records that already appear in the log are never double-imported.

### Time and sessions *(my calls)*
- **Time zone.** Month and day boundaries use **Europe/Berlin** explicitly (the host's zone; the container runs in UTC). This sets the file names, "this month" and the daily bars.
- **A session's spend** is every line carrying that `chatId`: its turns, compaction, canvas reader, graph extraction of that chat, its jobs and attribution.

### Categories (purpose → category)
| Category | Purposes |
|---|---|
| Teaching | prober, teacher turns; compaction in a teach session |
| Practice | practice turns; compaction in a practice session |
| Canvas reader | drawing transcriber |
| Graph | extractor, auditor |
| Background jobs | researcher, demo-builder, visual-maker |
| Library | OCR, document/concept/query embeddings, batch embeddings, describer, topicist |
| Learner model | attribution |
| Search | Tavily / Brave / Jina calls. These are logged so their failures are visible. They are unpriced, so they count in "calls" but not in dollars. |

### How (decided)
- **One wrapper for every LLM call** at the `streamFn` closure in `piEngineForSpec` (`src/agent/models.ts:~133`).
  - Every Agent, `runSubagent` and the visual-maker go through it, including the attempt `withEmptyErrorRetry` swallows.
  - The wrapper observes the final `AssistantMessage` (usage, stopReason, errorMessage, durationMs) without altering the stream.
  - The purpose and chat id reach the engine through `EngineOptions`: `{ purpose, chatId }`, set where engines are built (`resolveEngine(role)` knows the role; the conversation engine knows the chat and its kind; compaction sets its own purpose).
- **Embeddings, batches and OCR** are logged at their fetch seams: the `FetchLike` in `doc-index.ts`, and `ocr-client.ts`. Search calls are logged at `src/server/search.ts` and the Jina reader.
- **Logging never fails a call.** Writes are best-effort and never throw into a stream. An unwritable log dir disables logging with one console error.
- **Store.** A `RequestLogStore` port in core, an fs adapter in `src/store/`, wired in `stores.ts`. The agent layer gets a logger function injected (it cannot import `src/server`). The read side folds month files; it is a pure core fold, with a test per category.
- **Line shape (v1):**
  ```
  { v: 1, at, purpose, category, chatId?, chatKind?, provider, model, input?, output?, cacheRead?, cacheWrite?, cacheWrite1h?, providerCostUsd?, durationMs?, outcome: "ok"|"error"|"aborted", error?, imported? }
  ```
  - `error` is truncated to 1,000 chars.
  - Old month files never change.
- **Charts:** hand-made SVG bars in the app's style, no chart library. The daily bars are stacked, with category colours from the app palette, a tooltip with the day's split, and "—" days left empty.
- **The graph cost pill and panel** are replaced by the monthly pill and panel. The graph-pipeline numbers survive as the "Graph" category.
- **API:**
  - `GET /api/usage?month=YYYY-MM`: totals, categories, days, sessions, failure count;
  - `GET /api/usage/months`: 12-month totals;
  - `GET /api/usage/failures?month=&page=`.

### Non-goals
- Prompt or answer contents in the log (owner decision).
- Budgets, alerts and spend caps (the per-turn cap already exists).
- Deepgram token grants: they are not a usage call.
- Retention and rotation: monthly files are small (a few hundred bytes per call) and kept.

---

## Part B: Recommended models in the picker

### Why
The owner wants the TutorBench winners advertised next to Sonnet 5.5 and Opus 5.5, as "recommended" and "cheapest". The default model does not change.

### Decided
- When the search box is empty, `ModelMenuList` shows a **Recommended** group at the top, then the full list as today.
- **Members, in order:**

  | Model | Badge | Line |
  |---|---|---|
  | Claude Opus 5.5 | Recommended | best quality |
  | Claude Sonnet 5.5 | Recommended | strong and faster |
  | MiMo-V2.6 Flash | Cheapest | best value in TutorBench |
  | DeepSeek V4.1 Flash | Cheapest | fastest |

- **Provider resolution:** each member is shown in the first form the learner has a key for. Claude takes `anthropic:claude-opus-5-5`, else `openrouter:anthropic/claude-opus-5.5` (same for Sonnet). MiMo and DeepSeek take their `openrouter:` ids. A member with no available form is left out. The group is hidden when it would be empty.
- **Where it appears:** the per-session picker, the strong slot in Settings, and first-run setup. The cheap and vision slot pickers serve other roles and get no group.
- The keyboard walk stays one linear index over group plus list. Recommended entries also stay in the full list.
- The list is a constant in core (`RECOMMENDED_MODELS`), with a one-line provenance note (TutorBench 2026-10-28).

### Non-goals
Changing defaults; hiding `:batch` variants (a separate cleanup if wanted).

---

## Part C: Smarter note placement, without destroying notes

### Why
Since 0.28.0, notes can sit on top of each other when their marks are close, and a note can cover the learner's own typed labels. Today a note longer than two lines is also cut with "…". The owner wants smarter placement without destroying the notes.

### Decided
- **A note is never shortened or dropped.** It wraps at the same width into as many lines as it needs. The full text also stays in the `<title>`.
- **Collision-aware placement** (a pure function in teacher-ink geometry, deterministic):
  - For each note in mark order, try candidate spots around its mark: below, above, right, left, then the four diagonals, each just clear of the mark. Take the first spot that overlaps none of:
    - already placed notes;
    - any mark's drawn geometry;
    - the learner's typed objects (text/LaTeX/table boxes from the scene).
  - If no candidate is free, take the one with the least overlap area, nudged outward step by step up to a bounded distance.
- **Leader line.** When a note ends up away from its mark (any spot not adjacent to it), a thin line in the mark's colour joins the note to the mark.
- **Notes may leave the drawing box** when they need the room (a never-shortened note can't always fit a wide, short drawing). The chat thumbnail grows its view box to include every note, so nothing is clipped. On the live canvas, the 0.28.0 reveal still brings every note into view, since the boxes come from the same geometry. *(My call: the owner's "without destroying the notes" outranks "inside the box".)*
- **Stable spots while zooming.** On the live canvas, placement is solved once per marking turn, at the zoom in effect after the reveal, and each note keeps its spot (its side of the mark) while the learner zooms. Only the text size follows the 13 px screen floor. Notes never jump. *(My call.)*
- **Applies to both** the chat thumbnail and the live canvas, with the same algorithm in both coordinate spaces.

### Non-goals
Rewording notes; moving the learner's content; animation.

---

## Verification
- Unit tests:
  - the log line per call kind (ok, error, aborted, retried);
  - the month fold and categories;
  - the backfill being idempotent;
  - the picker group's provider resolution;
  - placement (no overlap among notes in a crowded fixture; no truncation; a leader line when moved; deterministic).
- A live check on a scratch server (cheap models only):
  - a teaching turn, a canvas hint, a forced failure (an invalid model or key), and a document import;
  - then confirm the pill, the panel, the Settings → Usage graphs and the failed-requests entry;
  - screenshots at 390px and desktop.
- After deploy, run the backfill on the owner's live data and compare this month's total with the sum of the old channels.

## Left to the builder
- Exact copy for the panel and Settings headings.
- Colours per category from the palette.
- Chart sizing.
- The nudge step and the maximum distance in placement.
- How engines receive `{purpose, chatId}` at each construction site.
- Test shapes, following the repo law.
