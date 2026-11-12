# Prompt fragments

The runtime composes prompts for three agents: **prober**, **teacher** and **practice**. The source of truth is `listSourceSegments` / `effectivePromptSegments` in [`src/agent/prompt-segments.ts`](../prompt-segments.ts); `composeInstructions` in [`src/agent/teacher-agent.ts`](../teacher-agent.ts) picks each segment's effective text, trims it, drops empty segments and joins the rest with `\n\n---\n\n`. Files that are not fragments (like this README) never enter a prompt: the loader only accepts filenames matching the numeric prefix (`FRAGMENT_RE` in `src/core/prompt-segments.ts`).

## Composition order

| Agent | Segments, in order |
|---|---|
| Prober | `system-prompt.md` → sorted `prober/` fragments → sorted `shared/` fragments |
| Teacher | `system-prompt.md` → sorted `teacher/` fragments → sorted `shared/` fragments |
| Practice | sorted `practice/` fragments → the curated shared appendix below; **no `system-prompt.md`** |

- `src/agent/system-prompt.md` is the base shared by prober and teacher: the agent intro, the voice, the philosophy and the accuracy rule. The teaching method (Principle i / Principle ii, the click, the arc, the hedge) lives in `teacher/05-method.md`; the prober never teaches.
- Fragments in an agent's own directory are sorted by filename, so the agent's job and method lead the composition. Keep numeric prefixes consistently padded when order matters.
- `shared/` fragments are a trailing appendix (tool, file and format mechanics). Prober and teacher compose **every** `shared/` fragment (today 11 files: voice, accuracy, mental model, question tools, exercise tools, canvas tasks, canvas tools, confidence, library, documents, formatting).
- Practice has its own base and doctrine (`practice/00-base.md`, `practice/10-doctrine.md`). Its shared appendix is an explicit allowlist in `PRACTICE_SHARED_FRAGMENTS`: `10-voice.md`, `15-accuracy.md`, `16-mental-model.md`, `24-canvas-tools.md` and `40-formatting.md`, in sorted order. The canvas section is split for that reason: `24-canvas-tools.md` (reading and marking a drawing) is true for every agent that can see one, while `24-canvas-tasks.md` (posing a task, coaching, closing it with `grade`) names tools practice does not hold and stays out of the allowlist. A new `shared/` fragment therefore reaches prober and teacher automatically but **not** practice, unless it is added to that allowlist.

## Overrides

Source files are the defaults. Override files mirror the segment paths under `promptsOverrideDir()` in [`config.ts`](../../../config.ts), which is `<global data root>/prompts/` (`data/prompts/` by default, relocated by `LH_DATA_DIR`):

```text
system-prompt.md
prober/<fragment>.md
teacher/<fragment>.md
practice/<fragment>.md
shared/<fragment>.md
```

An override composes only when **both** the user's `agent.prompts[segmentPath]` switch is `true` **and** the file is readable. A switch without a file, or a file without a switch, composes the source text. An enabled but empty override contributes nothing after trimming; it does not fall back to the source.

In the multi-user deployment the two halves live in different places:

- The override **text** is global to the instance (one `prompts/` directory), and writing or deleting it is **admin-only** (`PUT`/`DELETE /api/settings/prompts/[...segment]`). Settings → Agent shows the text read-only to everyone else.
- The on/off **switch** is per user (`agent.prompts` in each user's settings), so a user chooses whether the shared override applies to their own sessions.

Shared segments use one key across every agent that includes them, so one override and one switch cover all of them. `GET /api/settings/prompts` returns the effective segments per agent (`teacher`, `prober`, `practice`); the settings editor derives each shared fragment's "Used by …" hint from which of those lists contain it. The segment list always comes from current source discovery, so an override for a fragment the source no longer ships stops composing but stays on disk. The path grammar is in `src/core/prompt-segments.ts`, the override file CRUD in `src/store/prompt-overrides.ts`; the agent-side reader in `prompt-segments.ts` is separate because the agent layer never imports the store.

## Rules for adding a fragment

- Name it with a numeric order prefix, inside the right agent directory.
- Put cross-agent guidance in `shared/` only if every agent that composes it holds the tools it mentions: it is phase-neutral by construction (`20-question-tools.md` is tool MECHANICS only; what to ask is each phase's own doctrine; `22-exercise-tools.md` documents the exercise tool, called `exercise` or `assess` by phase, and its field names are test-pinned). Check the practice allowlist before assuming practice sees it.
- One fragment per workstream.
- Document YOUR agent's tools and behaviours exactly; cite tool input field names verbatim (they must match the schemas in `src/agent/tools.ts` and `src/agent/tools/`).
- Keep it tight: fragments are always in context. Do not restate the base prompt.
- The agents share one transcript but never one toolset: never reference another agent's tools as if you had them.
- When you change loader behaviour, check `tests/prompt-overrides.test.ts`.
