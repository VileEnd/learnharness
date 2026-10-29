/**
 * The one-time usage backfill against bad records, and the first read after
 * boot (cost counter final fixes). Isolated LH_DATA_DIR, so every app-module
 * import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ExtractionRunUsage } from "../src/core/contracts.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-usage-backfill-"));
process.env.LH_DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { PATHS } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { requestLogStore } = await import("../src/store/request-log.ts");
const { runUsageBackfill, usageMonth } = await import("../src/server/usage.ts");

const PRICED = "openrouter:z-ai/glm-5.3-flash";
const step = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });

const chat = chatStore.createChat("Extraction history");
// An old run recorded before extraction runs carried stages.
chatStore.appendExtractionUsage(chat.id, { startedAt: 1, at: "2026-10-03T10:00:00.000Z", durationMs: 1 } as unknown as ExtractionRunUsage);
chatStore.appendExtractionUsage(chat.id, {
	startedAt: 2,
	at: "2026-10-04T10:00:00.000Z",
	durationMs: 1,
	stages: { extractor: { model: PRICED, steps: [step(2000, 300)] }, auditor: { model: PRICED, steps: [step(900, 50)] } },
});
// A record that breaks in a way no guard foresees: a turn without steps.
const broken = chatStore.createChat("Broken");
chatStore.appendTurnUsage(broken.id, { id: "t1", messageId: "m1", at: "2026-10-05T10:00:00.000Z", model: PRICED } as never);

test("a run without stages and a broken record do not stop the backfill", () => {
	assert.deepEqual(runUsageBackfill(), { imported: 2 });
	assert.deepEqual(
		requestLogStore.readMonth("2026-10").map((l) => [l.purpose, l.input]),
		[["extractor", 2000], ["auditor", 900]],
	);
	assert.equal(requestLogStore.backfillDone(), true);
});

test("the first usageMonth on a fresh log already includes the imported lines", () => {
	fs.rmSync(PATHS.logs, { recursive: true, force: true });
	const view = usageMonth("2026-10");
	assert.equal(view.calls, 2);
	assert.ok(view.totalUsd !== null && view.totalUsd > 0);
	assert.equal(requestLogStore.backfillDone(), true);
});
