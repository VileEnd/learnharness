/**
 * The usage API (cost counter, 2026-10-29): the one-time backfill of old
 * records into the request log, and the three read endpoints. Isolated
 * LH_DATA_DIR, so every app-module import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-usage-api-"));
process.env.LH_DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { PATHS } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { documentStore } = await import("../src/store/documents.ts");
const { requestLogStore } = await import("../src/store/request-log.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { lineCost } = await import("../src/core/usage.ts");
const { runUsageBackfill, usageMonth } = await import("../src/server/usage.ts");
const usageRoute = await import("../app/api/usage/route.ts");
const failuresRoute = await import("../app/api/usage/failures/route.ts");

const PRICED = "openrouter:z-ai/glm-5.3-flash";
const step = (input: number, output: number) => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cacheWrite1hTokens: 0,
	reasoningTokens: 0,
});

// One chat with two turns (2 steps + 1 step), one research job with two
// calls, one OCR'd document: 3 + 2 + 1 = 6 lines.
const chat = chatStore.createChat("Chain rule");
chatStore.appendTurnUsage(chat.id, { id: "t1", messageId: "m1", at: "2026-10-05T10:00:00.000Z", model: PRICED, steps: [step(1000, 200), step(1500, 100)] });
chatStore.appendTurnUsage(chat.id, { id: "t2", messageId: "m2", at: "2026-10-06T10:00:00.000Z", model: PRICED, steps: [step(800, 50)] });
const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc1" });
jobStore.updateJob(job.id, {
	status: "done",
	usage: { model: PRICED, inputTokens: 3000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 2, calls: [step(1000, 100), step(2000, 200)] },
});
const jobFile = path.join(PATHS.data, "jobs", `${job.id}.json`);
fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf-8")), createdAt: "2026-10-07T10:00:00.000Z" }));
documentStore.save(
	{
		id: "doc_0123456789ab",
		contentHash: "h",
		minhash: [],
		title: "Scanned",
		summary: "",
		topics: [],
		filenames: ["scan.pdf"],
		importedAt: "2026-10-08T10:00:00.000Z",
		updatedAt: "2026-10-08T10:00:00.000Z",
		origin: "pdf",
		ocr: { job: "j1", strategy: "mistral", costUsd: 0.25 },
		sections: [],
		sourceId: "doc_0123456789ab",
	},
	"# Scanned",
);

const pricedSum = (month: string) =>
	requestLogStore.readMonth(month).reduce((sum, l) => sum + (lineCost(l, callCost) ?? 0), 0);

test("the backfill imports every record once", () => {
	assert.deepEqual(runUsageBackfill(), { imported: 6 });
	const lines = requestLogStore.readMonth("2026-10");
	assert.equal(lines.length, 6);
	assert.ok(lines.every((l) => l.imported === true));
	assert.deepEqual(
		lines.map((l) => l.purpose).sort(),
		["ocr", "researcher", "researcher", "teacher", "teacher", "teacher"],
	);
	assert.deepEqual(runUsageBackfill(), { imported: 0 });
	assert.equal(requestLogStore.readMonth("2026-10").length, 6);
});

test("GET /api/usage?month=2026-10 returns the month view", async () => {
	const res = await usageRoute.GET(new Request("http://test/api/usage?month=2026-10"));
	assert.equal(res.status, 200);
	const view = (await res.json()) as Awaited<ReturnType<typeof usageMonth>>;
	assert.equal(view.month, "2026-10");
	assert.ok(view.totalUsd !== null && view.totalUsd > 0.25);
	assert.ok(Math.abs(view.totalUsd - pricedSum("2026-10")) < 1e-12);
	assert.deepEqual(view.sessions.map((s) => ({ chatId: s.chatId, title: s.title, kind: s.kind })), [
		{ chatId: chat.id, title: "Chain rule", kind: "teach" },
	]);
});

test("GET /api/usage/failures?page=0 lists failures newest first", async () => {
	const fail = (at: string) => ({ v: 1 as const, at, purpose: "teacher", category: "teaching" as const, provider: "p", model: "m", outcome: "error" as const, error: at });
	requestLogStore.append(fail("2026-10-20T10:00:00.000Z"));
	requestLogStore.append(fail("2026-10-22T10:00:00.000Z"));
	requestLogStore.append(fail("2026-10-21T10:00:00.000Z"));
	const res = await failuresRoute.GET(new Request("http://test/api/usage/failures?month=2026-10&page=0"));
	assert.equal(res.status, 200);
	const body = (await res.json()) as { lines: { error: string }[]; total: number; pageSize: number };
	assert.equal(body.pageSize, 50);
	assert.equal(body.total, 3);
	assert.deepEqual(body.lines.map((l) => l.error), ["2026-10-22T10:00:00.000Z", "2026-10-21T10:00:00.000Z", "2026-10-20T10:00:00.000Z"]);
});

test("a deleted chat keeps its spend, as a deleted session", () => {
	const before = usageMonth("2026-10").totalUsd;
	chatStore.deleteChat(chat.id);
	const view = usageMonth("2026-10");
	assert.equal(view.totalUsd, before);
	assert.deepEqual(view.sessions.map((s) => ({ title: s.title, kind: s.kind })), [{ title: "Deleted session", kind: "deleted" }]);
});

test("records at or after the oldest live line are not imported again", () => {
	fs.rmSync(PATHS.logs, { recursive: true, force: true });
	const chat2 = chatStore.createChat("Second");
	chatStore.appendTurnUsage(chat2.id, { id: "u1", messageId: "n1", at: "2026-10-05T10:00:00.000Z", model: PRICED, steps: [step(10, 1), step(20, 2)] });
	chatStore.appendTurnUsage(chat2.id, { id: "u2", messageId: "n2", at: "2026-10-06T10:00:00.000Z", model: PRICED, steps: [step(30, 3)] });
	// A live line at T: turn u2 (at T), and the OCR document after it, were logged live.
	requestLogStore.append({ v: 1, at: "2026-10-06T10:00:00.000Z", purpose: "teacher", category: "teaching", chatId: chat2.id, provider: "openrouter", model: "z-ai/glm-5.3-flash", input: 30, output: 3, outcome: "ok" });
	assert.deepEqual(runUsageBackfill(), { imported: 2 });
	assert.equal(requestLogStore.readMonth("2026-10").filter((l) => l.imported).length, 2);
});
