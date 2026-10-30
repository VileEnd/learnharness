# Upstream Port 5: Deepgram Dictation Language — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each user can choose the language Deepgram transcribes. Today it is always the nova-3 default.

**Architecture:** Hand port of the upstream dictation-language feature:
- a core language list
- a per-user setting
- a searchable picker shared with the model menu
- a `language` parameter on the Deepgram websocket URL

Settings are already per tenant (0.30.0), so no tenancy work is needed.

**Tech Stack:** React, TypeScript, node:test.

**Spec:** group J of the owner-approved evaluation. It lives outside the repo: read it, never commit it. Upstream commits (`git show <sha>`): 3bb28e5, fbafc5e, f5a655b, 27e2770, 8337836. The merge is 0348897.

## Global Constraints
- **Per-user setting.** The language is a per-user setting (`dictation.language`) in the existing settings record. It is validated in `src/server/settings-body.ts` and sanitized in `src/core/settings.ts`.
- **Absent value.** An unset language sends no `language` param, so the Deepgram default applies.
- **Language list.** Use upstream's Nova-3 code list (`src/core/dictation.ts`) as is.
- **Picker placement.** The picker goes where the fork's dictation controls and settings live. The fork has no `general-section.tsx`: check `components/settings/settings-dialog.tsx` SECTIONS ("General") and `components/dictation.tsx`. Extract `SearchMenuList` from `components/settings/model-menu.tsx` the way upstream did. Keep the fork's model-menu behaviour (recommended models, policy-filtered catalog) intact.
- **Key copy.** API keys are admin-managed (0.32.0). Setup copy for a missing Deepgram key must say an admin adds it, with no "add your key" link for non-admins.
- **Token mint.** `/api/stt/token` stays unchanged: one shared admin key, short-lived grant.
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails.
- **Version:** `0.38.0`.

## Review Focus
1. The websocket URL contains `language=<code>` only when a language is set, and the code is URL-encoded and from the allowed list.
2. The model picker still works after the `SearchMenuList` extraction: search, recommended group, allowed-models filter.
3. A non-admin sees "ask your admin" copy for a missing Deepgram key.

---

### Task 1: Port the dictation language feature
**Files:**
- `src/core/dictation.ts` (new or extended)
- `src/core/settings.ts`, `src/server/settings-body.ts`, `src/core/settings-resolution.ts`
- `components/dictation.tsx`
- `components/dictation-language.tsx` (new)
- `components/settings/search-menu-list.tsx` (new, extracted)
- `components/settings/model-menu.tsx`
- the settings section that hosts the picker

**Tests:** port the upstream tests and add fork cases:
- (a) no language set → no `language` param; language set → the encoded param
- (b) a restricted user can set their language: it is not a model, so the policy is unaffected
- (c) the model menu still renders the recommended group and search after the extraction
- (d) missing-key copy for a non-admin mentions the admin

- [ ] Steps:
  1. RED → implement → GREEN.
  2. Bump the version to 0.38.0.
  3. Run the full gate line.
  4. Commit `feat(upstream): Deepgram dictation language`.

### Task 2: Deploy (controller)
Merge, then `systemctl restart learnharness-stack`. Check health, tag v0.38.0 and publish the release.
