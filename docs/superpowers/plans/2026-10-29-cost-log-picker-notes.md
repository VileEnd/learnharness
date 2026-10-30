# Cost Log, Recommended Models and Note Placement: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three things.
- An append-only request log of every paid call, feeding a monthly cost pill, a breakdown panel and a Settings → Usage page.
- A Recommended group in the model picker.
- Collision-aware teacher notes that are never shortened.

**Architecture:**
- **Request log.**
  - The pure core holds the line contract and the month folds.
  - An fs store writes `data/logs/requests-YYYY-MM.jsonl` (Europe/Berlin months).
  - LLM calls are observed once, at the `streamFn` closure in `piEngineForSpec`, through an injected sink. Non-pi calls (embeddings, OCR, search) are observed at their fetch seams.
  - Dollars are priced at read time with `callCost`, except provider-reported dollars.
- **Picker.** A core constant plus a resolver feeds `ModelMenuList`.
- **Notes.** Placement is a pure layout function used by `TeacherInk` and its box helper.

**Tech Stack:** Next.js 16, TypeScript strict, pi-ai/pi-agent-core, node:test via tsx, hand-made SVG.

**Spec:** `docs/superpowers/specs/2026-10-29-cost-log-picker-notes-design.md`

## Global Constraints

- Node 26 (`source ~/.nvm/nvm.sh && nvm use 26`).
- Import law: components → `@/src/core` only; app → core + server barrels only. `src/agent` never imports `src/server`/`src/store`. Explicit `.ts` relative imports and `import type`.
- Gates per task: `npm run typecheck`, `npm test`, `npm run lint`. Before the release, also `npm run build`. Never commit `next-env.d.ts`.
- `tests/fixtures/golden-data/` stays unchanged. The new log lives in a new dir and is created lazily, so golden data never contains it.
- Money law: dollars are inferred at read time from tokens + `provider:id` via `callCost`. Only provider-reported dollars are stored: OCR `cost_usd`, the batch `usage.cost`, OpenRouter's sync `/embeddings` cost. Unpriced → `null` → "—", never $0.
- Logging is a side channel: it never throws into a call, a stream or a turn. An unwritable log dir costs one `console.error`, then is silent.
- The log holds no prompt and no answer text. Only `error` text, truncated to 1,000 chars.
- Months and days use the `Europe/Berlin` time zone.
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LhT9KenWud21KXv5SkYQUz
  ```

## Review Focus

1. **An unwritable log dir, or a sink that throws,** must leave the model call and its stream untouched. Pinned in Task 2 (`sink throws → stream still completes`).
2. **A retried empty error** (`withEmptyErrorRetry`) must log both attempts: one `error` line and one `ok` line. **An abort** logs `aborted` with whatever usage arrived. Pinned in Task 2.
3. **Berlin month edge:** a call at `2026-10-31T23:30:00Z` belongs to November and goes into `requests-2026-11.jsonl`. Pinned in Task 1.
4. **Backfill idempotency:**
   - running it twice adds nothing;
   - records newer than the first live log line are not imported, so they are not double-counted;
   - a chat deleted after the backfill keeps its spend.
   
   Pinned in Task 4.
5. **Picker key availability:**
   - with only an OpenRouter key, the Claude members resolve to `openrouter:anthropic/claude-*-5.5`;
   - with no form available, a member is dropped;
   - the group is hidden when empty or when the search box has text.
   
   Pinned in Task 7.
6. **Crowded notes:**
   - five marks within one cell give five notes with no pairwise overlap;
   - a 90-char note keeps all its words.
   
   Pinned in Task 8.

---

### Task 1: Request-log contract, store and month folds

**Files:**
- Create: `src/core/contracts/usage.ts` (export it from the `src/core/contracts.ts` barrel)
- Create: `src/core/usage.ts` (pure; export it from `src/core/index.ts`)
- Modify: `src/core/ports.ts` (add `RequestLogStore`)
- Create: `src/store/request-log.ts`
- Modify: `config.ts` `PATHS` (add `logs: path.join(DATA_ROOT, "logs")`)
- Modify: `src/server/stores.ts` (add `requestLog`)
- Test: `tests/usage-fold.test.ts`, `tests/request-log-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // contracts/usage.ts
  export type UsageCategory = "teaching" | "practice" | "canvas-reader" | "graph" | "jobs" | "library" | "learner" | "search";
  export type RequestOutcome = "ok" | "error" | "aborted";
  export interface RequestLogLine {
    v: 1; at: string /* ISO, request start */; purpose: string; category: UsageCategory;
    chatId?: string; chatKind?: "teach" | "practice"; provider: string; model: string;
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number;
    providerCostUsd?: number; durationMs?: number; outcome: RequestOutcome; error?: string; imported?: true;
  }
  export interface CategoryTotal { usd: number | null; calls: number; tokens: number; unpriced: number }
  export interface UsageMonth {
    month: string; totalUsd: number | null; calls: number; unpricedCalls: number; failures: number;
    categories: Record<UsageCategory, CategoryTotal>;
    days: Array<{ day: string /* YYYY-MM-DD */; byCategory: Partial<Record<UsageCategory, number>> }>;
    sessions: Array<{ chatId: string; usd: number | null; calls: number }>; // sorted by usd desc, null last
  }
  // core/usage.ts
  export const USAGE_TZ = "Europe/Berlin";
  export function monthKey(at: string | Date): string;   // "YYYY-MM" in USAGE_TZ
  export function dayKey(at: string | Date): string;     // "YYYY-MM-DD" in USAGE_TZ
  export function categoryOf(purpose: string, chatKind?: "teach" | "practice"): UsageCategory;
  export function lineCost(line: RequestLogLine, price: (call: Partial<CallUsage>, modelId: string) => number | null): number | null;
  export function summarizeMonth(month: string, lines: readonly RequestLogLine[], price: Parameters<typeof lineCost>[1]): UsageMonth;
  export function truncateError(text: string): string;   // ≤ 1000 chars
  // ports.ts
  export interface RequestLogStore { append(line: RequestLogLine): void; readMonth(month: string): RequestLogLine[]; months(): string[]; backfillDone(): boolean; markBackfilled(): void }
  ```
- `categoryOf` mapping (spec table):

  | Purpose | Category |
  |---|---|
  | `prober`, `teacher` | `"teaching"` |
  | `practice` | `"practice"` |
  | `compaction` | by `chatKind` (`practice` → `"practice"`, else `"teaching"`) |
  | `transcriber` | `"canvas-reader"` |
  | `extractor`, `auditor` | `"graph"` |
  | `researcher`, `demo-builder`, `visual-maker` | `"jobs"` |
  | `ocr`, `embed`, `embed-batch`, `describer`, `topicist` | `"library"` |
  | `attribution` | `"learner"` |
  | `search` | `"search"` |
  | anything else | `"teaching"` if `chatId` is set, else `"library"` |

- `lineCost`: when `providerCostUsd` is set, return it. Otherwise return `price({inputTokens: input, outputTokens: output, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens}, `${provider}:${model}`)`. Lines with `outcome: "error"` and no usage return `null`, but they do NOT count as unpriced; only billable lines count.

- [ ] **Step 1: Write failing tests.**
  - `tests/usage-fold.test.ts`:
    - `monthKey("2026-10-31T23:30:00Z") === "2026-11"` and `dayKey(...) === "2026-11-01"`.
    - `categoryOf("compaction","practice") === "practice"`.
    - `summarizeMonth`:
      - 3 priced lines (2 teaching for chat A, 1 graph for chat A) plus 1 unpriced library line give `totalUsd` = the sum of the priced lines and `unpricedCalls === 1`;
      - `categories.graph.calls === 1`;
      - `sessions[0].chatId === "A"`;
      - an error line with no usage gives `failures === 1` and leaves `unpricedCalls` unchanged;
      - a `providerCostUsd: 0.0021` line adds exactly 0.0021;
      - all lines unpriced gives `totalUsd === null`.
    - `truncateError("x".repeat(5000)).length === 1000`.
  - `tests/request-log-store.test.ts`, with an isolated `LH_DATA_DIR` and dynamic imports:
    - append two lines in different months, then `months()` returns both, sorted;
    - `readMonth` skips a torn last line;
    - `backfillDone()` is false until `markBackfilled()`;
    - no dir exists until the first append.
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/usage-fold.test.ts tests/request-log-store.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - The store follows `src/store/learner.ts`: lazy mkdir, `appendFileSync`, never-throwing reads, an `isRequestLogLine` guard.
  - File name: `requests-${monthKey(line.at)}.jsonl` under `PATHS.logs`.
  - The backfill marker is `PATHS.logs/backfill.done`.
  - `monthKey`/`dayKey` use `Intl.DateTimeFormat("en-CA", { timeZone: USAGE_TZ, … })`.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(usage): request-log contract, store and month folds`.

---

### Task 2: Observe every LLM call

**Files:**
- Create: `src/agent/request-log.ts`
- Modify: `src/agent/models.ts:103-139` (`EngineOptions`, the `streamFn` wrapper)
- Modify: the engine construction sites so each passes `purpose` (and `chatId`/`chatKind` where known):
  - `src/server/chat-handler.ts`: `resolveEngine` (~182) passes `purpose: role`; the conversation engine (~273) passes `purpose: record.kind === "practice" ? "practice" : (teaching ? "teacher" : "prober")`, `chatId` and `chatKind`; compaction (~690, plus `compaction.ts`) passes `purpose: "compaction"`;
  - the job runner (`makeLoopContext`, chatId in scope) and the extraction pipeline;
  - `submit-agent` callers (extractor, auditor, describer, topicist, attribution);
  - `visual-maker.ts`, which bypasses `runSubagent` but uses `engine.streamFn`, so it is covered once its engine has a purpose.
- Modify: `src/server/stores.ts`, or the server composition root that runs at startup, to call `setRequestSink((line) => stores.requestLog.append(line))`.
- Test: `tests/request-log-llm.test.ts`

**Interfaces:**
- Consumes: Task 1 `RequestLogLine`, `categoryOf`, `truncateError`.
- Produces:
  ```ts
  // agent/request-log.ts
  export type RequestSink = (line: RequestLogLine) => void;
  export function setRequestSink(sink: RequestSink | null): void;
  export function recordRequest(line: RequestLogLine): void; // never throws; a throwing sink is caught (one console.error per process)
  export function observeStream(stream: AssistantMessageEventStream, meta: { purpose: string; chatId?: string; chatKind?: "teach" | "practice"; provider: string; model: string; startedAt: number }): AssistantMessageEventStream;
  // models.ts
  export interface EngineOptions { thinking?: "lowest"; purpose?: string; chatId?: string; chatKind?: "teach" | "practice" }
  ```
- `observeStream` re-emits every event unchanged, following the pattern of `withEmptyErrorRetry` in `turn-nudge.ts`. On `done` it records `ok`; on `error` it records `error`, or `aborted` when `stopReason === "aborted"`. Each line takes:
  - usage from the final message (`input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h`);
  - `durationMs = Date.now() - startedAt`;
  - `error = truncateError(errorMessage)`.

  An engine with no `purpose` logs `purpose: "unlabelled"` (`categoryOf` falls back).

- [ ] **Step 1: Write failing tests** in `tests/request-log-llm.test.ts`. Build an engine via `piEngineForSpec` with a faux provider, or wrap a faux `streamFn` through `observeStream` directly, with a test sink collecting lines:
  - **ok:** one line, `outcome "ok"`, `purpose "teacher"`, `chatId "c1"`, `category "teaching"`, `input`/`output` equal to the faux usage, `durationMs >= 0`.
  - **error:** `outcome "error"`, and `error` contains the message.
  - **aborted:** `outcome "aborted"`.
  - **Retry:** `withEmptyErrorRetry(observed)` where the first attempt is an empty transient error and the second succeeds gives 2 lines, `["error","ok"]`. The retry wraps the observed `streamFn` exactly as in `teacher-agent.ts`.
  - **Sink throws:** the stream still yields every event and its `result()` resolves.
  - **No prompt text:** `JSON.stringify(line)` contains none of the faux context's message text.
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/request-log-llm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `piEngineForSpec`, `streamFn` returns `observeStream(models.streamSimple(...), { purpose: opts.purpose ?? "unlabelled", chatId: opts.chatId, chatKind: opts.chatKind, provider: model.provider, model: model.id, startedAt: Date.now() })`.
  - The chat id comes only from `opts.chatId`; never derive it from `sessionId`.
  - Thread the purposes listed under Files.
- [ ] **Step 4: Run the gates.** Grep that every `piEngineForSpec(` and `resolveEngine(` call site passes a purpose, apart from tests. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(usage): every LLM call writes one request-log line`.

---

### Task 3: Observe embeddings, OCR and search

**Files:**
- Modify: `src/server/doc-index.ts`. Wrap the `fetchFn` passed to `openRouterEmbedder` (:99) and `openRouterBatchClient` (:183):
  - sync embeddings take `purpose` `"embed"`, and `providerCostUsd` from the response's `usage.cost` when present;
  - batch completion takes `purpose` `"embed-batch"`, with `providerCostUsd = BatchState.usage.cost`, logged once at completion (~811);
  - query and concept embeddings are logged as `"embed"`.
- Modify: `src/server/ocr-client.ts` (:97–168). Log `purpose "ocr"`:
  - on completion, `providerCostUsd = cost_usd` and `outcome "ok"`;
  - on `OcrError` or a non-2xx response, `outcome "error"` with the error text.
- Modify: `src/server/search.ts` (`tavilyProvider` :35, `braveProvider` :79) and `src/agent/tools/web.ts` (the Jina fetch :57). Log `purpose "search"`, with no usage and `outcome` from the HTTP status. `web.ts` is agent layer, so use `recordRequest` from `src/agent/request-log.ts`.
- Test: `tests/request-log-fetch.test.ts`

**Interfaces:**
- Consumes: Task 2 `recordRequest`, Task 1 `RequestLogLine`.
- Produces: a server-side helper `loggedFetch(fetchFn: FetchLike, meta: { purpose: string; provider: string; model: string; chatId?: string }, costOf?: (body: unknown) => number | undefined): FetchLike` in a new file `src/server/logged-fetch.ts`.
  - It clones the response to read the cost, so it never consumes the caller's body.
  - It never throws; on a network throw it logs `error` and rethrows the original error.

- [ ] **Step 1: Write failing tests**, with stubbed fetch:
  - an embed call with response `{data:[…], usage:{cost:0.00002}}` gives one `"embed"` line with `providerCostUsd 0.00002`, and the embedder still returns its vectors;
  - an embed 500 that is retried and then succeeds gives an `error` line followed by an `ok` line;
  - OCR success with `cost_usd 0.04` gives an `"ocr"` line with `providerCostUsd 0.04`; an OCR failure gives an `error` line;
  - a Tavily 401 gives a `"search"` line with `outcome "error"`.
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/request-log-fetch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as listed under Files.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(usage): embeddings, OCR and search calls write request-log lines`.

---

### Task 4: Backfill and the usage API

**Files:**
- Create: `src/server/usage.ts` (export it from the `src/server/index.ts` barrel)
- Create: `app/api/usage/route.ts` (GET `?month=YYYY-MM`, default the current Berlin month)
- Create: `app/api/usage/months/route.ts`
- Create: `app/api/usage/failures/route.ts` (GET `?month=&page=`)
- Modify: the server startup path that already runs once per process (where `setRequestSink` is wired in Task 2), to call `runUsageBackfill()` once, async and contained.
- Test: `tests/usage-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export interface UsageMonthView extends UsageMonth { sessions: Array<UsageMonth["sessions"][number] & { title: string; kind: "teach" | "practice" | "deleted" }> }
  export function usageMonth(month?: string): UsageMonthView;              // prices with callCost
  export function usageMonths(): Array<{ month: string; totalUsd: number | null; unpricedCalls: number }>; // last 12 with data, oldest first
  export function usageFailures(month: string, page: number): { lines: RequestLogLine[]; total: number; pageSize: 50 }; // newest first
  export function runUsageBackfill(): { imported: number } ;               // no-op once backfill.done exists
  ```
- **Backfill imports**, as `imported: true` lines at their own times, but only records older than the oldest non-imported line already in the log (or everything when the log is empty):
  - every chat's `turns`: one line per step, `at = turn.at`, purpose by chat kind (`compaction` and reader turns by their id prefix if one exists, else the chat kind);
  - `extractions` per stage step: purpose `extractor` / `auditor`, `at = run.at`;
  - `NotesSource.extractions`, the same way;
  - jobs: their `calls[]` when present, else one line with the totals; `at = createdAt`; purpose = the job kind's role;
  - documents with `ocr.costUsd`: one `"ocr"` line, `at = importedAt`, `providerCostUsd`.

  It then calls `markBackfilled()`.

- [ ] **Step 1: Write failing tests**, with an isolated data dir seeded with one chat (2 turns), one job and one OCR document:
  - **Backfill:**
    - `runUsageBackfill()` imports the expected count;
    - a second run imports 0;
    - after deleting the chat, `usageMonth()` still includes its spend and the session's `kind` is `"deleted"`.
  - **No double-counting:** a live line appended before the backfill, at time T, means records at or after T are not imported.
  - **The API:** `GET /api/usage?month=2026-10` returns `UsageMonthView` with `totalUsd` equal to the summed priced lines.
  - **Failures:** `failures?page=0` returns the newest first, with `pageSize 50`.
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/usage-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Session titles come from `chatStore.getChat(id)?.title`; a missing chat gives `"Deleted session"` with kind `"deleted"`.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(usage): one-time backfill and the usage API`.

---

### Task 5: Monthly pill and breakdown panel on home

**Files:**
- Create: `components/usage/month-pill.tsx`
- Modify: `components/minimal-home.tsx:25,110-113,198` and `components/graph-view.tsx` (~1157-1166 fetch, ~1612 render). Replace `GraphCostControl` / `/api/graph/costs` with `UsageMonthControl` / `/api/usage`, always rendered.
- Delete: `GraphCostControl`, `GraphCostPanel`, `graphUsageLabel`, `displayCostTotals` and `fmtRunCost` from `graph-view.tsx`; `app/api/graph/costs/route.ts`; `graphCosts` in `src/server/graph.ts`; `src/core/cost-summary.ts` and its tests, unless still used. Grep first.
- Test: `tests/render-usage.test.tsx`

**Interfaces:**
- Consumes: Task 4 `UsageMonthView`, `usage-format.ts` `costLabel` / `formatUsd`.
- Produces: `export function UsageMonthControl({ usage }: { usage: UsageMonthView | null }): JSX.Element` and a pure `export function UsageMonthPanel({ usage }: { usage: UsageMonthView })`.
- **Pill text:** `This month ${costLabel(totalUsd)}`. While loading it shows `This month —`.
- **Panel:**
  - the total, and when `unpricedCalls > 0` the line "`${n} calls unpriced`";
  - category rows with a non-zero call count, in the spec's order, with dollars (`costLabel`) and calls;
  - "`${sessions.length} sessions with spend`";
  - the top 5 sessions, each a link to `/chat/<id>` (a deleted session is plain text);
  - "`${failures} failed requests`", linking to Settings → Usage (`useSettingsDialog().open("usage")`);
  - a "Details" link to the same place.
- Refetch on mount and when the activity feed reports a finished turn or job, as the old pill did.

- [ ] **Step 1: Write failing render tests** (`renderToStaticMarkup`):
  - the pill shows `This month $0.42` for `totalUsd: 0.42`, and `This month —` for `null`;
  - the panel lists "Teaching" and "Graph" rows with their calls;
  - the panel shows "2 calls unpriced";
  - the top sessions link to `/chat/A`;
  - the panel shows "1 failed request" (singular), and "3 failed requests" for 3.
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/render-usage.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing `usePopoverDismiss` and the pill styling of the old `GraphCostControl`.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(usage): monthly cost pill and breakdown on home (replaces the graph cost pill)`.

---

### Task 6: Settings → Usage, with graphs and failed requests

**Files:**
- Create: `components/settings/usage-section.tsx`
- Create: `components/usage/charts.tsx` (pure SVG)
- Modify: `components/settings/settings-dialog.tsx:59-66` (`SECTIONS`) and the content column (~366-452)
- Test: `tests/render-usage-section.test.tsx`

**Interfaces:**
- Consumes: Task 4 `/api/usage`, `/api/usage/months` and `/api/usage/failures`; Task 1 types.
- Produces:
  - `export function DailyBars({ days, month }: { days: UsageMonth["days"]; month: string })`: one stacked bar per calendar day of the month, empty days drawn empty, and a `<title>` tooltip per bar with the day's split;
  - `export function MonthBars({ months }: { months: ReturnType<typeof usageMonths> })`;
  - `export const CATEGORY_COLORS: Record<UsageCategory, string>`, from the app palette in `components/canvas/geometry.ts`, or the CSS tokens the app already uses for accents.
- **The section, top to bottom:**
  1. a month `<select>` (the months with data, newest first);
  2. the total, plus the unpriced line;
  3. `DailyBars`;
  4. `MonthBars`;
  5. the category table (dollars, calls, tokens, unpriced);
  6. the session table (title, kind, dollars, calls);
  7. the failed-requests list: local time, purpose, model, error (expandable), chat link; with "Older" / "Newer" paging by 50.
- An empty month says "No requests logged this month."

- [ ] **Step 1: Write failing render tests:**
  - `DailyBars` for October renders 31 bar groups, and a day with 2 categories renders 2 `<rect>` segments;
  - `MonthBars` renders one bar per month;
  - the section with a stubbed view lists a failure row with its error text and a link to `/chat/c1`;
  - "Usage" appears in the settings nav (`SECTIONS` includes `{ id: "usage", label: "Usage" }`).
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/render-usage-section.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The section fetches its own routes; there is no `UserSettings` field.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(usage): Settings → Usage with daily and monthly charts and failed requests`.

---

### Task 7: Recommended group in the model picker

**Files:**
- Create: `src/core/recommended-models.ts` (export it from `src/core/index.ts`)
- Modify: `components/settings/model-menu.tsx:35-145` (`ModelMenuList` gains `recommended?: boolean`)
- Modify: `components/model-picker.tsx:387` (session/draft picker: `recommended`), `components/settings/agent-section.tsx:721` (`recommended` only for slot `strong`), `components/setup-dialog.tsx:510` (strong pick: `recommended`)
- Test: `tests/recommended-models.test.ts`, plus a render case in the existing model-menu render test (or a new `tests/render-model-menu.test.tsx`)

**Interfaces:**
- Produces:
  ```ts
  export interface RecommendedModel { key: string; badge: "Recommended" | "Cheapest"; line: string; forms: ReadonlyArray<{ provider: string; id: string }> }
  export const RECOMMENDED_MODELS: readonly RecommendedModel[]; // provenance comment: TutorBench 2026-10-28, 7 tutors × 7 scenarios, Opus judges; Opus/Sonnet not benchmarked (owner rule)
  export function recommendedFor<M extends { provider: string; id: string }>(models: readonly M[]): Array<{ entry: RecommendedModel; model: M }>;
  ```
- **Exact entries:**
  1. `opus`: Recommended, "best quality"; forms `anthropic:claude-opus-5-5`, then `openrouter:anthropic/claude-opus-5.5`.
  2. `sonnet`: Recommended, "strong and faster"; forms `anthropic:claude-sonnet-5-5`, then `openrouter:anthropic/claude-sonnet-5.5`.
  3. `mimo-flash`: Cheapest, "TutorBench #1 · ~$0.13/session"; form `openrouter:xiaomi/mimo-v2.6-flash`.
  4. `deepseek-flash`: Cheapest, "TutorBench #4 · ~$0.14/session · fastest"; form `openrouter:deepseek/deepseek-v4.1-flash`.
- **ModelMenuList behaviour:**
  - With `recommended` and an empty query, it renders a "Recommended" header and the resolved rows (name, badge chip, line, the usual `priceLabel`), then the full list. The rows also stay in the full list.
  - The keyboard index is one linear array: group rows first, then list rows.
  - `data-testid="model-option-rec-<key>"`.

- [ ] **Step 1: Write failing tests.**
  - `recommendedFor`:
    - with only openrouter models present (including `anthropic/claude-opus-5.5`), Opus resolves to the openrouter form;
    - with both anthropic and openrouter present, the anthropic form wins;
    - with no MiMo, the result has 3 entries in order opus, sonnet, deepseek-flash;
    - with no models, the result is `[]`.
  - Render: the group header appears for an empty query and is absent with query "glm"; the MiMo row shows "TutorBench #1".
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/recommended-models.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(picker): Recommended group with TutorBench rank on the cheap picks`.

---

### Task 8: Collision-aware notes, never shortened

**Files:**
- Create: `components/canvas/note-layout.ts` (pure)
- Modify: `components/canvas/teacher-ink.tsx`:
  - `NOTE_MAX_LINES` and the "…" cut in `noteLines` (:98,121) are removed;
  - `notePlace` / `HandNote` / `teacherInkBoxes` (:162-366) consume the layout;
  - a leader line is added.
- Modify: `components/work-cards.tsx:55-66` (the thumbnail grows its view box to include every note; the image keeps its aspect inside the larger paper)
- Modify: `components/canvas/canvas-workspace.tsx` (stable spots: the live canvas solves placement once per marking turn at the post-reveal zoom and keeps each note's side while the learner zooms)
- Test: `tests/note-layout.test.ts`, plus updated cases in `tests/render-canvas.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type Box = { x: number; y: number; w: number; h: number };
  export type Side = "below" | "above" | "right" | "left" | "below-right" | "below-left" | "above-right" | "above-left";
  export interface NoteRequest { markBox: Box; w: number; h: number; prefer?: Side }
  export interface PlacedNote { box: Box; side: Side; leader: boolean } // leader when the box is not adjacent to markBox
  export function layoutNotes(notes: readonly NoteRequest[], obstacles: readonly Box[], gap: number, fixedSides?: readonly (Side | undefined)[]): PlacedNote[];
  ```
- **Algorithm:**
  1. For each note in order, try the sides in the `Side` order above (`prefer` first). Each spot sits `gap` clear of `markBox`.
  2. Accept the first spot overlapping nothing in `obstacles ∪ placed`.
  3. If none is free, push outward along each side in steps of `gap` for up to 6 steps. Take the first free spot, else the spot with the least total overlap area; then `leader: true`.
  4. `fixedSides[i]`, when given, forces that side (the stable spots on zoom); the outward push still applies.
- **Obstacles** are every mark's drawn geometry box plus the learner's typed-object boxes from the scene (text, markdown, LaTeX, table and image objects). Freehand strokes are not obstacles.
- `teacherInkBoxes` returns the placed note boxes, so the reveal and the thumbnail view box use the same geometry.
- **The leader** is a thin line (stroke width `u*0.5`) in the mark's colour, from the note's nearest edge midpoint to the mark box's nearest point.

- [ ] **Step 1: Write failing tests.**
  - `tests/note-layout.test.ts`:
    - five notes whose `markBox`es lie within one 40×40 area give pairwise non-overlapping boxes;
    - a note whose 4 sides are blocked by obstacles is pushed outward with `leader: true`;
    - the same input gives deep-equal output (deterministic);
    - `fixedSides: ["above"]` gives `side "above"`.
  - `render-canvas.test.tsx`:
    - a 90-char label renders every word across its `<tspan>`s, with no "…";
    - a moved note renders a leader `<line>`;
    - the thumbnail `<svg>` `viewBox` contains every note box;
    - the old "two-tspan cap" assertion is replaced.
- [ ] **Step 2: Run** `NODE_ENV=test npx tsx --test tests/note-layout.test.ts tests/render-canvas.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(canvas): notes find free space, never shortened, with leader lines`.

---

### Task 9: Live check, release 0.29.0 and live backfill

- [ ] **Step 1: Live check on a scratch server.**
  - Setup: port 3030, a golden-data copy, `LH_AUTH_FILE=~/.config/learnharness/dev-auth.json`, and cheap models only (DeepSeek V4.1 Flash; reader `qwen/qwen3.7-flash`). Cap: $0.30.
  - Run:
    1. a teaching turn;
    2. a canvas task with a hint on a crowded drawing;
    3. a forced failure: set the cheap slot to a nonexistent model id for one extraction, or use an invalid search key;
    4. a document import (embeddings).
  - Confirm:
    - the pill and panel numbers equal the sum of the log lines;
    - Settings → Usage shows the bars, tables and the failure with its error text;
    - the picker's Recommended group;
    - the notes don't overlap, with leader lines where moved.
  - Screenshots at 390px and 1280px.
  - Kill the server by PID.
- [ ] **Step 2: Release.**
  1. Bump to `0.29.0`.
  2. Run the gates and `npm run build`.
  3. Push and open the PR.
  4. Merge, tag `v0.29.0`, create the release.
  5. Deploy with `ssh root@learnharness.fritz.box systemctl restart learnharness-stack`.
- [ ] **Step 3: On the live server**, confirm:
  - `backfill.done` exists and `requests-2026-10.jsonl` has imported lines;
  - `GET /api/usage` returns this month's total;
  - a new teaching turn by the owner appends a live line (or a container-internal test call, if none happens).
