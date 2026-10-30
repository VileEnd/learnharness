# Upstream Port 1: Small Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring over a set of small upstream (amosblomqvist/learnharness 0.3.9/0.4.0) fixes, adapted to the fork.

**Architecture:** These are ports of individual upstream commits. Use `git show <sha>` on the `upstream` remote (it is already fetched in /home/test/learnharness/learnharness). Each change is adapted to fork code and keeps the fork's multi-user policy checks.

**Tech Stack:** Next.js 16, TypeScript, streamdown, node:test.

**Spec:** the owner-approved porting evaluation at `/home/test/learnharness/upstream-eval.md`, groups A, B, C, D, E (label part only) and P. That file is outside the repo; read it, but do not commit it.

## Global Constraints
- Keep fork behaviour wherever upstream conflicts with it:
  - multi-user policy write checks;
  - the BYOK, browser-only architecture;
  - the fork's recommended-models setup.
- **E (label fix):** port only the `:free` fix, where `prettyModel` splits only when the id is qualified. **Keep the fork's date-suffix trimming.** The owner ruling cited in the fork's comment stands.
- **D:** the unchanged-pin bypass applies to catalog existence ONLY. Restricted users' new selections still go through the allow-list (`sectionModelRefusal` / the policy checks in `src/server/settings-body.ts`).
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails.
- Version `0.34.0`.

## Review Focus
1. **The Next 16.4.3 bump (DEFERRED to on or after 2026-11-06 under the two-week supply-chain rule; not in this branch, Next stays on 16.4.1).** `next` and `@next/eslint-plugin-next` must be on the same version, and the standalone build and Docker trace must still work. Owner: Task 1 (full gate including the smoke scripts).
2. **Math repair.** `htmlTags:false` must not let real partial HTML tags through. The streaming render test should include a non-math `<` case. Owner: Task 1.
3. **Policy after D.** A restricted user re-saving an unchanged but now-disallowed pin must still be overlaid and gated at runtime; the D bypass only affects catalog validation. Owner: Task 2 test.

---

### Task 1: Compression smoke (A; the Next 16.4.3 bump is deferred to on or after 2026-11-06), streaming math (B), streaming math (B), trivial fixes (P)
**Files:**
- `package.json` / `package-lock.json`: DEFERRED (on or after 2026-11-06, two-week supply-chain rule; not in this branch). `next` and `@next/eslint-plugin-next` to the same 16.4.3 or later stable release, at least two weeks old.
- From upstream 59f389d, adapted: `scripts/smoke-compression-runtime.mjs`, its call in `scripts/smoke-server.mjs`, and `tests/next-compression-drain.test.ts`.
- From upstream 3c76930: `components/ai-elements/message.tsx` and `components/ai-elements/reasoning.tsx` (`remend={{ htmlTags: false }}`), plus `tests/render-streaming-math.test.tsx`.
- P (upstream cb7e719/31ea0c9, 8ad17a4/27abb31): `tests/schema-stamps.test.ts` (`import.meta.dirname`) and the relative doc links in `docs/development.md`, if the fork still has those defects.

- [ ] **Step 1:** Port the tests first and run them to see RED. The compression smoke is a regression guard: it passes on 16.4.1 and does not detect a leak there.
- [ ] **Step 2:** Apply the changes. **Step 3:** Run the full gate line. **Step 4:** Commit `chore(upstream): next 16.4.3 gzip fix, streaming math, small fixes`.

### Task 2: compaction leftovers (C), slot repair (D), `:free` label (E)
**Files:**
- From upstream b81f0a3, server half only: `src/server/compaction.ts`.
  - Throw when the summarizer's assistant message has `stopReason === "length"`; nothing is checkpointed.
  - When a prior summary exists, filter `customType === "compaction"` markers out of the span before `serializeForSummary`.
  - Add the `docs/compaction-accounting.md` note and port the relevant `tests/compaction-service.test.ts` cases.
- From upstream 88ba42f, adapted:
  - `validateModelsSettings(settings, stored)` skips catalog existence for a slot whose provider and id are unchanged from the stored raw record.
  - The settings route reads the raw record first, using the existing `settingsStore.readSettings()` raw path.
  - Policy checks stay on new selections.
- From upstream 683eb93, the `prettyModel` part only: `components/usage-format.ts` (or wherever the fork's `prettyModel` lives) splits only qualified ids. **Keep date-suffix trimming.**

**Tests (failing first):**
- (a) A length-stopped summary throws and nothing is checkpointed.
- (b) Prior compaction markers are excluded from the summarizer input.
- (c) Saving a different slot works while another stored slot's provider is gone from the catalog.
- (d) A restricted user cannot newly pin a disallowed model through the D path. That gives 403 `model_not_allowed`.
- (e) `prettyModel("vendor/model:free")` does not render as "free". An existing date-suffix test stays green.

- [ ] Steps: RED → implement → GREEN → bump the version to 0.34.0 → full gate line → commit `fix(upstream): compaction leftovers, slot repair after a provider disappears, :free labels`.

### Task 3: Deploy (controller)
Merge, then `systemctl restart learnharness-stack`. Check that health is OK and that the container's Next version is still 16.4.1 (bump deferred). Tag v0.34.0 and publish the release.
