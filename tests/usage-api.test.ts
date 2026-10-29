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
const { newCompactionMarker } = await import("../src/core/compaction.ts");
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

// One chat with two turns (2 steps + 1 step), a compaction turn (1 step) and
// an extraction run (extractor + auditor steps); a research job with two
// calls and a demo job with totals only; an OCR'd document and a second one
// reusing its scan: 3 + 1 + 2 + 2 + 1 + 1 = 10 lines.
const chat = chatStore.createChat("Chain rule");
chatStore.appendTurnUsage(chat.id, { id: "t1", messageId: "m1", at: "2026-10-05T10:00:00.000Z", model: PRICED, steps: [step(1000, 200), step(1500, 100)] });
chatStore.appendTurnUsage(chat.id, { id: "t2", messageId: "m2", at: "2026-10-06T10:00:00.000Z", model: PRICED, steps: [step(800, 50)] });
const marker = newCompactionMarker("summary", { firstKeptMessageId: "m2", tokensBefore: 1000, model: PRICED, at: "2026-10-06T11:00:00.000Z" });
chatStore.saveMessages(chat.id, [marker]);
chatStore.appendTurnUsage(chat.id, { id: "c1", messageId: marker.id, at: "2026-10-06T11:00:00.000Z", model: PRICED, steps: [step(5000, 400)] });
chatStore.appendExtractionUsage(chat.id, {
	startedAt: 1,
	at: "2026-10-06T12:00:00.000Z",
	durationMs: 1000,
	stages: { extractor: { model: PRICED, steps: [step(2000, 300)] }, auditor: { model: PRICED, steps: [step(900, 50)] } },
});
/** Pin a job's dates (createJob stamps now). */
function dateJob(id: string, createdAt: string, updatedAt: string): void {
	const file = path.join(PATHS.data, "jobs", `${id}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), createdAt, updatedAt }));
}
const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc1" });
jobStore.updateJob(job.id, {
	status: "done",
	usage: { model: PRICED, inputTokens: 3000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 2, calls: [step(1000, 100), step(2000, 200)] },
});
dateJob(job.id, "2026-10-07T10:00:00.000Z", "2026-10-07T10:05:00.000Z");
const demo = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "tc2" });
jobStore.updateJob(demo.id, {
	status: "done",
	usage: { model: PRICED, inputTokens: 4000, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 3 },
});
dateJob(demo.id, "2026-10-07T12:00:00.000Z", "2026-10-07T12:05:00.000Z");
const scanned = (id: string, importedAt: string) =>
	documentStore.save(
		{
			id,
			contentHash: id,
			minhash: [],
			title: "Scanned",
			summary: "",
			topics: [],
			filenames: ["scan.pdf"],
			importedAt,
			updatedAt: importedAt,
			origin: "pdf",
			ocr: { job: "j1", strategy: "mistral", costUsd: 0.25 },
			sections: [],
			sourceId: id,
		},
		"# Scanned",
	);
scanned("doc_0123456789ab", "2026-10-08T10:00:00.000Z");
// "Import as new" of the same PDF: the known scan's job and cost are copied.
scanned("doc_ba9876543210", "2026-10-09T10:00:00.000Z");

const pricedSum = (month: string) =>
	requestLogStore.readMonth(month).reduce((sum, l) => sum + (lineCost(l, callCost) ?? 0), 0);

test("the backfill imports every record once", () => {
	assert.deepEqual(runUsageBackfill(), { imported: 10 });
	const lines = requestLogStore.readMonth("2026-10");
	assert.equal(lines.length, 10);
	assert.ok(lines.every((l) => l.imported === true));
	assert.deepEqual(
		lines.map((l) => l.purpose).sort(),
		["auditor", "compaction", "demoBuilder", "extractor", "ocr", "researcher", "researcher", "teacher", "teacher", "teacher"],
	);
	// One OCR job is one charge, at its first import.
	assert.deepEqual(lines.filter((l) => l.purpose === "ocr").map((l) => [l.at, l.providerCostUsd]), [["2026-10-08T10:00:00.000Z", 0.25]]);
	// A job without calls[] is one line with its totals.
	assert.deepEqual(lines.filter((l) => l.purpose === "demoBuilder").map((l) => [l.input, l.output]), [[4000, 600]]);
	assert.deepEqual(runUsageBackfill(), { imported: 0 });
	assert.equal(requestLogStore.readMonth("2026-10").length, 10);
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

test("GET /api/usage rejects a malformed month", async () => {
	const res = await usageRoute.GET(new Request("http://test/api/usage?month=2026-13"));
	assert.equal(res.status, 400);
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
	// A job that ran on past T: its calls were logged live too.
	const late = jobStore.createJob({ kind: "research", chatId: chat2.id, toolCallId: "tc3" });
	jobStore.updateJob(late.id, { status: "done", usage: { model: PRICED, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 1, calls: [step(1, 1)] } });
	dateJob(late.id, "2026-10-05T12:00:00.000Z", "2026-10-06T12:00:00.000Z");
	// A live line at T: turn u2 (at T), and every record completed after it, were logged live.
	requestLogStore.append({ v: 1, at: "2026-10-06T10:00:00.000Z", purpose: "teacher", category: "teaching", chatId: chat2.id, provider: "openrouter", model: "z-ai/glm-5.3-flash", input: 30, output: 3, outcome: "ok" });
	assert.deepEqual(runUsageBackfill(), { imported: 2 });
	assert.equal(requestLogStore.readMonth("2026-10").filter((l) => l.imported).length, 2);
});
