# Golden fixtures — real user data, read through production paths

**The law (owner ruling, 2026-10-10):** this directory is a REAL data dir —
verbatim records written by the real application code, never hand-edited. Any
intentional on-disk format change updates these fixtures IN THE SAME COMMIT;
an unintentional change fails `tests/golden-fixtures.test.ts`. When schema
stamps land (Wave D), the stamping commit updates these files with it.

`tests/golden-fixtures.test.ts` copies this dir to a temp dir, points the
production stores at it via the `LH_DATA_DIR` seam, and reads EVERYTHING
through the real read paths — chat records (contract folds + the LLM wire
flattening), graph ledgers (shape guards + the full derivation), jobs,
settings. It also pins marker COVERAGE: every custom-marker kind and the
core tool surface must appear in real data here.

## What's inside

- `chats/chat_mv27rrra_feff23b6.json` — the teach-side master (owner-built,
  2026-10-10): probe-handoff, plan-block, compaction, subagent-steer,
  subagent-abort, and every teach tool (quiz, ask_user_question, plan_init,
  probe, probe_done, recall, explain, research, demo, visual, pdf, find,
  grep, ls, read, list_sessions, list_propositions). Plan tree + 25 turn
  records + a per-chat model override.
- `chats/chat_mvqwyk18_da3a4b82.json` — the interactive exercises (dev server on a
  scratch data dir, 2026-10-27): a teach-phase chat with three answered `exercise`
  calls (numeric first-try correct; table solved on the second Check after a hint;
  multipart given up) plus the prober's `probe`/`recall`/`grade`. Stamped (`version: 1`)
  by design; the unstamped pin is the master above.
- `chats/chat_mvr17zp1_fb98d9b6.json` + `drawings/chat_mvr17zp1_fb98d9b6/` — the canvas
  workspace (dev server on a scratch data dir, 2026-10-27, `settings.canvas: true`; the
  canvas driven in headless Chromium through the real workspace, so the PNGs come from
  `exportPng` with the region grid and `oN` badges and the scenes store palette names):
  three prober `sketch` tasks — the first graded by its exact id after one drawing
  submission, the second with a `hint-request`, two `work-submission`s (a drawing with
  a LaTeX object, then a resubmission of the unchanged scene, which reuses its
  content-addressed `drawingId`) and a grade, the third dismissed (`work-dismissed`);
  every submission here carries a drawing (text-only submissions are unit-tested);
  two refused `probe_done` calls in the grading turn (pre-fix: the record was frozen at
  write-ahead, see final-fix report) that conclude nothing, then the clean `probe_done`,
  the `probe-handoff` steer and `plan_init`. Drafts are kept (`drafts/<callId>.json`).
  Stamped (`version: 1`). Replaces `chat_mvr0bwhl_d3a812e8`, whose hand-POSTed drawing
  had no grid and whose refused `probe_done` had flipped the phase.
- `chats/chat_mv293wv5_10656952.json` — the practice lifecycle (owner-built,
  2026-10-10): graph-context (the bracketed preamble), problem ×2,
  practice-thinking ×2, conclude ×2, practice-next, problem-dismissed — the
  full marker cycle of a practice session, including the dismissal.
- `graph/` — the real ledgers: nodes (282 lines), chains (160), sessions (8),
  coverage (93), sources (4), render-settings, positions.
- `jobs/` — five legacy records covering kind × status: research done +
  aborted by learner, demo done, visual done, pdf error. Plus two
  delivery-era records (dev server on a scratch data dir, 2026-10-27): a
  research job that finished (`delivery: {kind: "result", status:
  "delivered"}`) and one the learner aborted (`delivery: {kind: "abort",
  status: "delivered"}`), both with the saved dispatch `input`.
- `settings.json` — the stamped settings record (version 1, model slots).

## Regenerating / extending

Run the app (`npm run dev`), exercise the feature against `data/`, then copy
the produced record in verbatim. Do not hand-edit content; if a record needs
pruning, re-run the flow instead.

## Stamps

These files are deliberately the UNSTAMPED legacy shape (schema-stamp wave,
2026-10-10): lazy v1 means absence reads as current-valid, so this set pins
the pre-stamp read path forever. Stamped writes (chat `version: 1`, the
`graph/format.json` sidecar) are pinned by `tests/schema-stamps.test.ts`.
New records copied in after their first post-stamp write will carry the
stamps — that shape is equally current-valid.
