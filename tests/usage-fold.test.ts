import assert from "node:assert/strict";
import test from "node:test";
import type { RequestLogLine } from "../src/core/contracts/usage.ts";
import { categoryOf, dayKey, lineCost, monthKey, summarizeMonth, truncateError } from "../src/core/usage.ts";

const base = { v: 1, provider: "p", model: "m", outcome: "ok" } as const;
const line = (o: Partial<RequestLogLine>): RequestLogLine => ({
	...base,
	at: "2026-10-05T10:00:00Z",
	purpose: "teacher",
	category: "teaching",
	...o,
});
// Priced when output tokens are present: $0.01 per 1000 output tokens.
const price = (c: { outputTokens?: number }) => (c.outputTokens === undefined ? null : c.outputTokens / 100000);

test("month and day keys use Europe/Berlin", () => {
	assert.equal(monthKey("2026-10-31T23:30:00Z"), "2026-11");
	assert.equal(dayKey("2026-10-31T23:30:00Z"), "2026-11-01");
});

test("categoryOf", () => {
	assert.equal(categoryOf("compaction", "practice"), "practice");
	assert.equal(categoryOf("compaction"), "teaching");
	assert.equal(categoryOf("demoBuilder"), "jobs");
	assert.equal(categoryOf("demo-builder"), "jobs");
	assert.equal(categoryOf("visualMaker"), "jobs");
	assert.equal(categoryOf("visual-maker"), "jobs");
	assert.equal(categoryOf("transcriber"), "canvas-reader");
	assert.equal(categoryOf("mystery"), "library");
	assert.equal(categoryOf("mystery", undefined, "chat1"), "teaching");
});

test("summarizeMonth folds priced, unpriced and failed lines", () => {
	const lines = [
		line({ chatId: "A", output: 1000 }),
		line({ chatId: "A", output: 2000 }),
		line({ chatId: "A", purpose: "extractor", category: "graph", output: 500 }),
		line({ purpose: "embed", category: "library", output: undefined, input: 10 }),
	];
	const m = summarizeMonth("2026-10", lines, price);
	assert.ok(Math.abs((m.totalUsd ?? 0) - 0.035) < 1e-9);
	assert.equal(m.unpricedCalls, 1);
	assert.equal(m.categories.graph.calls, 1);
	assert.equal(m.sessions[0]?.chatId, "A");

	const withErr = summarizeMonth("2026-10", [...lines, line({ outcome: "error", error: "boom" })], price);
	assert.equal(withErr.failures, 1);
	assert.equal(withErr.unpricedCalls, 1);
});

test("providerCostUsd wins and all-unpriced gives null", () => {
	const l = line({ providerCostUsd: 0.0021, output: 5 });
	assert.equal(lineCost(l, price), 0.0021);
	assert.equal(summarizeMonth("2026-10", [l], price).totalUsd, 0.0021);
	assert.equal(summarizeMonth("2026-10", [line({ input: 5 })], price).totalUsd, null);
});

test("truncateError caps at 1000", () => {
	assert.equal(truncateError("x".repeat(5000)).length, 1000);
});
