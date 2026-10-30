# Image Normalization (Upstream Port 8): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every image a model sees — library images read with `read`, headless page screenshots, visual-maker renders, and the canvas PNG sent to the session model and the transcriber — is sniffed, converted to a supported format, EXIF-rotated and resized below the model's inline limits before it is sent.

**Architecture:** A vendored port of pi-coding-agent's image processing (MIT), taken verbatim from upstream commit `84f9399` (`src/agent/image-processing/*`). It resizes in a worker using `@silvia-odwyer/photon-node` (WASM, so there is no per-platform native binary). The fork wires it into its own model paths, which differ from upstream: pdf-reader is gone, `read` is rooted at the OKF library, and the canvas paths are fork-only.

**Tech Stack:** Next.js 16 standalone, TypeScript, pi-ai 1.4.0 (`Model.inputLimits` exists), node:test, Docker.

**Spec:** group K of the owner-approved upstream evaluation (`upstream-eval.md`, kept outside the repo), plus upstream `84f9399`. Read it with `git -C <upstream checkout> show 84f9399:<path>`; the upstream checkout is `../learnharness` next to this worktree.

## Global Constraints
- **Vendored files are copied verbatim** from `84f9399`, keeping their MIT headers and `LICENSE`. Change only import paths if the fork needs it.
- **Dependency:** `@silvia-odwyer/photon-node` `0.3.4`, pinned exactly (published 2025-05-10).
- **The standalone image must load the WASM at runtime.** Add upstream's `next.config.ts` trace includes and the `serverExternalPackages` entry. Port `scripts/smoke-image-runtime.mjs` and add it to the Dockerfile gate line after `smoke-server.mjs`, the same way CI's order is documented in CLAUDE.md.
- **Per-model limits:** use `model.inputLimits?.images?.resize` where a model is known, as upstream does. A model without image input gets a text note and no image, matching upstream's `read` behaviour.
- **A failed conversion or resize never throws into the turn.** The model gets upstream's `[Image omitted: …]` text instead, following the side-channel containment invariant.
- **No on-disk format change:** golden fixtures unchanged. Stored drawings and assets stay as they are; only what is sent to models is processed.
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails.
- **Version:** `0.41.0`.

## Review Focus
1. A 12 MP phone JPEG with an EXIF rotation, placed on the canvas or in the library, reaches the model rotated upright and under the inline limits.
2. The production image really loads photon's WASM. The smoke script must fail if the trace misses it.
3. An unsupported or corrupt image yields an omitted-image note, never a failed turn.
4. The Claude Code engine forwards the processed images unchanged. Its transcript conversion takes image content as given.

---

### Task 1: Vendor the processing module and make the build carry it
**Files:**
- Create from `84f9399`, verbatim: `src/agent/image-processing/{LICENSE,convert.d.mts,convert.mjs,exif-orientation.mjs,index.ts,mime.d.mts,mime.mjs,photon.mjs,resize-core.d.mts,resize-core.mjs,resize-worker.mjs,resize.ts,types.ts}`, `scripts/smoke-image-runtime.mjs`, `tests/image-processing.test.ts`.
- Modify:
  - `package.json` and the lockfile (the dependency);
  - `next.config.ts` (the trace includes plus `serverExternalPackages`, merged with the fork's existing entries);
  - `Dockerfile` (the gate line gains `node scripts/smoke-image-runtime.mjs`);
  - `tests/provider-tracing.test.ts` (upstream's +3 lines, if the fork has that test);
  - `CLAUDE.md` (add the smoke script to the "standalone packaging checks" line).

**Interfaces:**
- Produces:
  - `processImage(bytes: Uint8Array, mimeType: string, options?: ProcessImageOptions): Promise<ProcessImageResult>`;
  - `detectSupportedImageMimeType(bytes)`, `detectSupportedImageMimeTypeFromFile(path)`;
  - the types `ModelImageResizeOptions`, `ProcessImageResult`, all from `src/agent/image-processing/index.ts`.
- Lint law: `src/agent` may hold this, and `src/server` may import it.

- [ ] **Step 1:** Port `tests/image-processing.test.ts`, then run it and see it FAIL (module missing).
- [ ] **Step 2:** Copy the vendored files and add the dependency (`npm install --save-exact @silvia-odwyer/photon-node@0.3.4`). Run it again and see it PASS.
- [ ] **Step 3:** Apply the `next.config.ts` and Dockerfile changes, then run `npm run build && node scripts/build-server.mjs && node scripts/smoke-server.mjs && node scripts/smoke-image-runtime.mjs`. All must pass, and the image smoke must actually resize an image inside `.next/standalone`; read the script to confirm it does.
- [ ] **Step 4:** Run `npm test`, typecheck and lint. Commit `feat(images): vendor Pi image processing (photon WASM) + runtime smoke`.

### Task 2: Process every model-visible image
**Files:**
- `src/agent/tools/read.ts`: `createReadTool(model?: ReadModel)`, ported from upstream's shape onto the fork's library-rooted resolver. Keep the fork's description text and its OKF root. Keep `readTool` as `createReadTool()` for existing callers.
- `src/agent/teacher-agent.ts` (and wherever prober and practice build their tool lists, if separate): bind `createReadTool(engine.model)` as upstream does.
- `src/agent/subagents/headless.ts` and `src/agent/subagents/visual-maker.ts`: upstream's processing of screenshots and renders, adapted.
- `src/server/drawing-context.ts`: the canvas PNG handed to the session model goes through `processImage` with the session model's limits. If processing fails, the model gets the omitted note while the transcription text still flows.
- `src/agent/subagents/drawing-transcriber.ts`: its PNG input is processed with the transcriber model's limits.
- Tests:
  - port `tests/agent-image-paths.test.ts`, dropping the pdf-reader cases and adding a drawing-context case;
  - adapt `tests/read-tool.test.ts` and `tests/demos.test.tsx` as upstream did.
- `package.json` version `0.41.0`.

**Interfaces:**
- Consumes (Task 1): `processImage`, `detectSupportedImageMimeTypeFromFile`.
- Produces: `createReadTool(model?: Pick<Model<Api>, "input" | "inputLimits">)`.

- [ ] **Step 1: Write the failing tests:**
  - `read returns an upright, resized image for an EXIF-rotated large JPEG`: build the fixture in the test with photon or a small inline JPEG that carries an orientation tag, as upstream's tests do. The result's dimensions are within the default limits and the orientation is applied.
  - `read of a corrupt .png yields the omitted note, not an error`.
  - `read for a text-only model attaches no image`.
  - `the drawing-context canvas PNG is processed with the session model's limits`: a model with `inputLimits.images.resize.maxWidth: 512` gets an image no wider than 512.
  - `headless screenshot and visual-maker outputs go through processImage`: port upstream's assertions.
- [ ] **Step 2:** Run them and see them FAIL. **Step 3:** Implement. **Step 4:** Run them and see them PASS.
- [ ] **Step 5:** Bump the version. Run the full gate line:

  ```
  npm run typecheck && npm test && npm run lint && npm run build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs && node scripts/smoke-image-runtime.mjs
  ```

  Commit `feat(images): normalize every model-visible image (0.41.0)`.

### Task 3: Deploy (controller)
Merge, then run `systemctl restart learnharness-stack`. The Dockerfile gate runs the image smoke during the VM build. Check health, tag v0.41.0, and publish the release.
