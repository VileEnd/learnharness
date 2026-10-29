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
	assert.equal(dayKey("2026-03-28T23:00:00Z"), "2026-03-29");
	assert.equal(dayKey("2026-10-25T23:00:00Z"), "2026-10-26");
	assert.equal(monthKey("2026-03-31T22:00:00Z"), "2026-04");
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

test("unknown category folds via purpose; null-usd sessions sort last", () => {
	const odd = line({ chatId: "B", purpose: "extractor", category: "future" as never, output: 100 });
	const m = summarizeMonth("2026-10", [line({ chatId: "N", input: 1 }), odd], price);
	assert.equal(m.categories.graph.calls, 1);
	assert.equal(m.sessions[0]?.chatId, "B");
	assert.equal(m.sessions[1]?.chatId, "N");
	assert.equal(m.sessions[1]?.usd, null);
});

test("search lines count as calls, never as unpriced; their failures still count", () => {
	const search = (o: Partial<RequestLogLine> = {}) => line({ purpose: "search", category: "search", provider: "tavily", model: "search", ...o });
	const m = summarizeMonth("2026-10", [line({ output: 1000 }), search(), search({ outcome: "error", error: "HTTP 401" })], price);
	assert.equal(m.calls, 3);
	assert.equal(m.categories.search.calls, 2);
	assert.equal(m.unpricedCalls, 0);
	assert.equal(m.categories.search.unpriced, 0);
	assert.equal(m.failures, 1);
	assert.ok(Math.abs((m.totalUsd ?? 0) - 0.01) < 1e-9);
});
