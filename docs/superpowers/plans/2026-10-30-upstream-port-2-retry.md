# Upstream Port 2: Retry a Failed Turn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a turn's model call fails, the learner can press **Retry**. The failed attempt stays in the saved record, the retried turn runs against the same history minus that trailing failure, and new output is saved after it.

**Architecture:** This is a hand port of upstream's `{type:"retry"}` input event, adapted to the fork's turn pipeline: tenancy, the model gate and caps, canvas, and `send_to_user`. It ships with upstream's stricter probe→teach seam, because Retry makes failed `probe_done` attempts reachable.

**Tech Stack:** Next.js 16, TypeScript, pi-agent-core, node:test.

**Spec:** group G of the owner-approved evaluation at `<upstream eval report>`. That file is outside the repo: read it, never commit it. Upstream commits, read via `git show <sha>`:
- a572675 (retry event)
- 82c6999 (keep failed responses)
- 5984eb4 (readable refusal text)
- 3b29b5e (retire stale recovery drafts)
- 3b97056 (test type)
- f01fdf3 (probe seam)

## Global Constraints
- **Retry goes through the normal turn path.**
  - Turn liveness: a concurrent request gets 409.
  - The write-ahead persist happens before streaming.
  - `modelGate` runs: cap, allow-list, and the per-turn spend clamped to the remaining budget (0.33.0).
  - Every attempt is logged by the request log, so retries count toward spend.
- **No new on-disk shape.** The golden fixtures (`tests/golden-fixtures.test.ts`) must pass unchanged.
- **Retry after a later compaction is refused** with a readable 400. No tool results are synthesized for tool calls inside failed generations.
- **Ruling (owner question, settled here):** policy refusals show **no Retry button**, because a retry would only be refused again. These are `monthly_cap_reached`, `model_not_allowed` and `policy_unavailable`. Retry is offered only for a failed model call. Every other refusal renders as readable text, extending 5984eb4's decode.
- **The probe seam** (f01fdf3, adapted to the fork's `isProbeConclusion` from #46): the teacher switch requires a `probe_done` call from a non-error, non-aborted assistant message AND a matching clean result.
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails.
- **Version:** `0.35.0`.

## Review Focus
1. A retry while a turn is running gets 409, the same as a send.
2. A retry by a user at their cap gets the cap refusal, with no Retry button and nothing persisted.
3. A failed `probe_done` (from an errored or aborted message, or with an error result) never switches prober → teacher, before or after a retry.
4. A retry when the last assistant message is not a failure is a readable 400, not a crash.
5. A reload mid-retry: the turn re-attaches through the existing turn-runs seam.

---

### Task 1: Server — the retry input event and the probe seam
**Files:**
- `src/core/input-events.ts`: retry event parsing and validation.
- `src/server/chat-handler.ts`: the retry branch. It builds the temporary agent history without the trailing failure, persists against the matching prefix, refuses after a later compaction, and keeps tenancy, gate and clamp behaviour.
- `src/core/native-messages.ts`, `src/core/phases.ts`, `src/agent/tools/probe.ts`: the probe seam, with `probeDoneResultIds` merged with the fork's `isProbeConclusion`.
- `docs/probe-teach-split.md`.

**Tests:**
- Port `tests/retry-failed-turn.test.ts`, adapted to fork fixtures and tenancy, and the f01fdf3 cases in `tests/phases.test.ts` and `tests/probe-done.test.ts`.
- Add fork-specific cases:
  - (a) a retry at the cap gives a 403 cap envelope and leaves the chat file unchanged;
  - (b) a retry during a running turn gives 409;
  - (c) a retry with no trailing failure gives a readable 400.

- [ ] Steps: RED → implement → GREEN (focused tests, `npm test`, typecheck, lint) → commit `feat(upstream): retry a failed turn (server) + stricter probe handoff`.

### Task 2: Client — Retry button, readable refusals, stale drafts
**Files:**
- `components/chat.tsx`: the Retry button on the turn error banner, shown only for failed model calls and never for policy refusals; stale recovery drafts are retired before a retry (3b29b5e).
- `components/session-core.ts`: sends the retry event; decodes refusal envelopes into readable text (5984eb4), including the fork's policy codes, which reuse `policyRefusalCopy` from `src/core/settings.ts`.

**Tests:** port the 82c6999 and 5984eb4 parts of `tests/session-core.test.ts` and the 3b29b5e cases in `tests/byok-refusal.test.ts`. Add a fork case: a policy refusal renders its copy and offers no retry.

- [ ] Steps: RED → implement → GREEN → bump the version to 0.35.0 → run the full gate line → commit `feat(upstream): Retry button and readable refusals`.

### Task 3: Deploy (controller)
Merge, then `systemctl restart learnharness-stack`. Check health, tag v0.35.0, and publish the release.
