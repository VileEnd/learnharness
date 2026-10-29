/** The request log's non-LLM side: embeddings, OCR and search write one line per call (cost counter, Task 3). */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RequestLogLine } from "../src/core/contracts/usage.ts";
import { setRequestSink } from "../src/agent/request-log.ts";
import { openRouterEmbedder } from "../src/server/doc-index.ts";
import { createOcrClient } from "../src/server/ocr-client.ts";
import { tavilyProvider } from "../src/server/search.ts";

let lines: RequestLogLine[] = [];
const collect = () => {
	lines = [];
	setRequestSink((line) => lines.push(line));
};
afterEach(() => setRequestSink(null));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers });
const embedding = { data: [{ index: 0, embedding: [1, 2, 3] }], usage: { cost: 0.00002 } };

describe("embeddings", () => {
	it("one embed line with the response's cost; the vectors still come back", async () => {
		collect();
		const out = await openRouterEmbedder("k", "emb-model", async () => json(embedding)).embed(["x"]);
		assert.deepEqual([...out[0]!], [1, 2, 3]);
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.purpose, "embed");
		assert.equal(lines[0]!.category, "library");
		assert.equal(lines[0]!.provider, "openrouter");
		assert.equal(lines[0]!.model, "emb-model");
		assert.equal(lines[0]!.providerCostUsd, 0.00002);
		assert.equal(lines[0]!.outcome, "ok");
	});

	it("a retried 500 logs an error line, then an ok line", async () => {
		collect();
		let n = 0;
		const fetchFn = async () => (++n === 1 ? json({ error: "boom" }, 500, { "retry-after": "0" }) : json(embedding));
		await openRouterEmbedder("k", "emb-model", fetchFn).embed(["x"]);
		assert.deepEqual(lines.map((l) => l.outcome), ["error", "ok"]);
		assert.equal(lines[0]!.providerCostUsd, undefined);
	});
});

describe("OCR", () => {
	const client = (job: unknown, status = 200) =>
		createOcrClient({ baseUrl: () => "http://ocr", token: () => undefined, key: () => "k", fetch: async () => json(job, status) });
	const done = { id: "j", status: "done", strategy: "vision", usd: 0.04, files: [{ name: "a.pdf", status: "done", cost_usd: 0.04, error: null }] };

	it("a finished job logs an ocr line with cost_usd", async () => {
		collect();
		await client(done).job("j");
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.purpose, "ocr");
		assert.equal(lines[0]!.provider, "ocr");
		assert.equal(lines[0]!.model, "vision");
		assert.equal(lines[0]!.providerCostUsd, 0.04);
		assert.equal(lines[0]!.outcome, "ok");
	});

	it("no reported cost: the line has no providerCostUsd (never 0)", async () => {
		collect();
		await client({ ...done, id: "nocost", files: [{ name: "a.pdf", status: "done" }] }).job("nocost");
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.outcome, "ok");
		assert.equal("providerCostUsd" in lines[0]!, false);
	});

	it("two done polls of one job log once; a done job with a failed file logs one error", async () => {
		collect();
		const c = client({ ...done, id: "twice" });
		await c.job("twice");
		await c.job("twice");
		assert.equal(lines.length, 1);
		lines.length = 0;
		const bad = { ...done, id: "badfile", files: [{ name: "a.pdf", status: "failed", cost_usd: 0.01, error: "page 3 unreadable" }] };
		await client(bad).job("badfile");
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.outcome, "error");
		assert.match(lines[0]!.error!, /page 3 unreadable/);
	});

	it("a failed job keeps the cost the sidecar reported", async () => {
		collect();
		const files = [
			{ name: "a.pdf", status: "done", cost_usd: 0.03, error: null },
			{ name: "b.pdf", status: "failed", cost_usd: 0.01, error: "page 3 unreadable" },
			{ name: "c.pdf", status: "failed", error: "never started" },
		];
		await client({ ...done, id: "partial", status: "failed", files }).job("partial");
		assert.equal(lines[0]!.outcome, "error");
		assert.ok(Math.abs(lines[0]!.providerCostUsd! - 0.04) < 1e-12);
		lines.length = 0;
		await client({ ...done, id: "nothing", status: "failed", files: [{ name: "a.pdf", status: "failed", error: "x" }] }).job("nothing");
		assert.equal("providerCostUsd" in lines[0]!, false);
	});

	it("a running job logs nothing; a non-2xx answer logs an error line", async () => {
		collect();
		await client({ ...done, status: "running" }).job("j");
		assert.equal(lines.length, 0);
		await assert.rejects(client({ error: "x" }, 500).job("j"), /HTTP 500/);
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.outcome, "error");
		assert.match(lines[0]!.error!, /HTTP 500/);
	});
});

describe("search", () => {
	it("a Tavily 401 logs a search line with outcome error", async () => {
		collect();
		await assert.rejects(tavilyProvider("k", async () => json({ detail: { error: "bad key" } }, 401)).search("q", 3), /401/);
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.purpose, "search");
		assert.equal(lines[0]!.category, "search");
		assert.equal(lines[0]!.provider, "tavily");
		assert.equal(lines[0]!.outcome, "error");
	});

});
