# Upstream Port 3: Pending-Question Alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The question dock always shows the question the native transcript says is open, draft answers stay with their own question, and a temporary placeholder never counts as an answer.

**Architecture:** This is a hand port of three upstream client and pure-core fixes. The fork's `danglingQuestionOf` (which since 0.35.0 skips error and aborted generations) becomes the one authority for the dock.

**Tech Stack:** React, TypeScript, node:test.

**Spec:** group F of the owner-approved evaluation at `<upstream eval report>`. That file is outside the repo: read it, never commit it. Upstream commits (`git show <sha>`):
- 82f0b59: `findPendingToolCall(view, nativeId)`, with chat.tsx passing `danglingQuestionOf(nativeMessages)?.toolCallId`.
- 6ff4924: occurrence-qualified pending keys.
- 3993122: transient `c_` questionResult placeholders (details null) are not answers.

The merges are de9caf6 and b493403.

## Global Constraints
- **Every fork question tool must be covered** by the occurrence logic and by the live-placeholder check:
  - quiz and ask_user_question;
  - numeric, blanks, table and multipart;
  - canvas work and sketch tasks, whose results can have different `details`.

  Read `QUESTION_TOOLS` and related definitions in src/core first.
- No server, tenancy or gate changes, and no on-disk change. The golden fixtures stay unchanged.
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails.
- Version `0.36.0`.

## Review Focus
1. **Repeated tool-call ids.** Legacy DeepSeek-style ids such as `call_0` repeat across turns. With such ids, drafts and resets stay with the right occurrence.
2. **Canvas and exercise docks** (fork-specific) still open and close correctly.
3. **Mid-stream placeholders.** A live placeholder result mid-stream keeps the question pending. A real result closes it.

---

### Task 1: Port 82f0b59, 6ff4924 and 3993122
**Files:**
- src/core/pending.ts
- src/core/native-messages.ts (only if needed)
- components/chat.tsx (~:494, the call site)
- components/session-core.ts, src/core/session.ts and src/core/view.ts (as upstream touched them)

**Tests:** port the upstream tests and adapt them to the fork's question kinds. Add fork cases:
- a canvas sketch task pending, then resolved;
- a numeric question with a repeated tool-call id across two turns, checking the draft key stays distinct;
- a placeholder result for a multipart question keeps it pending.

- [ ] Steps:
  1. RED.
  2. Implement.
  3. GREEN: the focused tests, then `npm test`.
  4. Bump the version to 0.36.0.
  5. Run the full gate line.
  6. Commit `fix(upstream): pending questions follow the native transcript; occurrence keys; live placeholders`.

### Task 2: Deploy (controller)
Merge, run `systemctl restart learnharness-stack`, check health, tag v0.36.0 and publish the release.
