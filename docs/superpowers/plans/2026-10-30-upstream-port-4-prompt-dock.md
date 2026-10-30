# Upstream Port 4: Opening Prompt Out of the URL + Measured Dock Sizing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A new session's first message no longer travels in the URL. Today it ends up in proxy headers, the auth redirect, access logs and browser history.
- The question and answer docks size themselves to the window, so they scroll properly on phones and short windows.

**Architecture:** Hand ports of upstream's `sessionStorage` handoff and measured dock height, adapted to fork-specific code:
- the cap refusal on new sessions (0.33.0);
- Retry (0.35.0);
- the extra dock kinds: canvas workspace, exercise formats, hints.

**Tech Stack:** React, TypeScript, node:test, linkedom render tests.

**Spec:** groups H and I of the owner-approved evaluation, which lives outside the repo; read it, never commit it. Upstream commits (`git show <sha>`):
- **H:** 472844e, f24fda9, 1ff60b4
- **I:** 42814ba, d30acd4

## Global Constraints
- **The opening prompt never appears in a URL.** That covers `/chat/<id>?prompt=` and any other query or hash. It is handed over through per-tab `sessionStorage` and removed once delivered.
- **Recovery:** a reload mid-handoff still delivers the message exactly once.
- **Torn-down view:** a refused opening (cap 403, models or keys 503) whose view was torn down keeps the draft recoverable (1ff60b4).
- **The 0.33.0 cap behaviour stays:** `POST /api/chats` over the cap creates no chat, shows the message, and keeps the draft.
- **Electron:** drop upstream's Electron-only parts. Port `scripts/smoke-opening-prompt.mjs` only if it is browser- or Node-based and fits the fork's gates. Otherwise skip it and say so.
- **Dock sizing:** it must cover every fork dock kind:
  - question
  - practice
  - exercise (all formats)
  - canvas workspace and hints
  - work

  None of them may lose its controls or toolbar in a short window, and long content scrolls inside the dock.
- **Scope:** no server or on-disk change.
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails.
- **Version:** `0.37.0`.

## Review Focus
1. A grep of components/ and app/ finds no `?prompt=` and no URL-encoded opening text left anywhere.
2. An over-cap new session still creates no chat and keeps the draft (0.33.0 test stays green).
3. Delivered exactly once: a fast double navigation, a reload, or a back button never sends the opening twice.
4. On a phone-sized viewport the canvas dock still shows its toolbar.

---

### Task 1: Opening prompt via sessionStorage (H)
**Files:**
- components/opening-prompt.ts (new)
- components/start-session.ts (new)
- components/new-session.tsx
- components/home.tsx
- components/chat.tsx
- components/session-core.ts
- components/session.ts

**Tests:** port tests/opening-prompt.test.ts, tests/opening-delivery.test.ts and the render-new-session cases. Add fork cases:
- an over-cap opening creates no chat, keeps the draft, and puts nothing in the URL;
- a refusal after teardown still lets the draft be recovered.

- [ ] Steps:
  1. RED.
  2. Implement.
  3. GREEN.
  4. Grep for leftover `?prompt=`.
  5. Commit `fix(upstream): opening message travels via sessionStorage, never the URL`.

### Task 2: Measured dock sizing (I)
**Files:**
- components/dock-height.ts (new)
- components/chat.tsx
- components/question-dock.tsx
- components/practice-dock.tsx
- the fork's canvas and exercise dock components, as needed

**Tests:** port tests/dock-height.test.tsx. Add fork cases for the canvas workspace dock and an exercise table format in a short window: controls stay visible and the content scrolls.

- [ ] Steps:
  1. RED.
  2. Implement.
  3. GREEN.
  4. Bump the version to 0.37.0.
  5. Run the full gate line.
  6. Commit `fix(upstream): measured dock sizing and short-window scrolling`.

### Task 3: Deploy (controller)
Merge, then run `systemctl restart learnharness-stack`. Check health, tag v0.37.0, and publish the release.
