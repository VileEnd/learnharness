/**
 * Indexing through the OpenRouter Batch API, no network: a stub fetch plays
 * OpenRouter (create / get / delete a batch), a fake clock drives the
 * debounce and the once-a-minute polling, and the real DocumentStore keeps
 * the vectors and the pending-batches file under an isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-batch-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { documentStore } = await import("../src/store/documents.ts");
const { conceptVectorStore } = await import("../src/store/concept-vectors.ts");
const { createDocIndex, openRouterBatchClient, buildBatchRequests } = await import("../src/server/doc-index.ts");
const { fingerprint } = await import("../src/core/documents.ts");
import type { BatchRequest } from "../src/server/doc-index.ts";
import type { DocumentMeta } from "../src/core/contracts/documents.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";

const scanRows = () => ((globalThis as { __lhDocumentScans?: Map<string, { title: string }> }).__lhDocumentScans ??= new Map());

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => {
	fs.rmSync(path.join(TMP_DATA, "documents"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP_DATA, "graph"), { recursive: true, force: true });
	scanRows().clear();
});

const MODEL = "google/gemini-embedding-2";
const MINUTE = 60_000;

const MUTEX = ["# Mutex", "", "Ein Mutex schützt einen kritischen Abschnitt.", "", Array.from({ length: 300 }, () => "füllwort").join(" ")].join("\n");
const SEMA = ["# Semaphoren", "", "Semaphoren zählen freie Ressourcen."].join("\n");

let counter = 0;
function put(title: string, markdown: string): DocumentMeta {
	const fp = fingerprint(markdown);
	const id = `doc_${String(++counter).padStart(12, "0")}`;
	const meta: DocumentMeta = {
		id,
		contentHash: fp.contentHash,
		minhash: fp.minhash,
		title,
		summary: "",
		topics: [],
		filenames: ["x.md"],
		importedAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		origin: "markdown",
		sections: fp.sections,
		sourceId: id,
	};
	documentStore.save(meta, markdown);
	return meta;
}

// ── a stub OpenRouter ────────────────────────────────────────────────────────

interface StubBatch {
	body: { endpoint: string; model: string; requests: BatchRequest[] };
	status: string;
	results: unknown[] | null;
	error: { message: string } | null;
}

const vec = (text: string) => [(text.length % 5) + 1, 1, 2];

function stubOpenRouter() {
	const batches = new Map<string, StubBatch>();
	const calls: string[] = [];
	const state = { maxRequests: Infinity, maxDocs: Infinity, submitStatus: 0, n: 0, submits: [] as string[] };
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	const fetchFn = async (url: string, init: RequestInit) => {
		const method = init.method ?? "GET";
		const id = url.split("/batches/")[1];
		calls.push(`${method} ${id ?? "create"}`);
		assert.equal((init.headers as Record<string, string>).authorization, "Bearer key");
		if (method === "POST") {
			const body = JSON.parse(init.body as string) as StubBatch["body"];
			assert.deepEqual(Object.keys(body), ["endpoint", "model", "requests"], "requests last");
			if (state.submitStatus) return json({ error: { message: `status ${state.submitStatus}` } }, state.submitStatus);
			const docsIn = new Set(body.requests.map((r: BatchRequest) => r.custom_id.slice(0, r.custom_id.lastIndexOf("~"))));
			if (body.requests.length > state.maxRequests || docsIn.size > state.maxDocs) return json({ error: { message: "too many requests" } }, 413);
			const batchId = `batch_${++state.n}`;
			batches.set(batchId, { body, status: "validating", results: null, error: null });
			state.submits.push(batchId);
			return json({ id: batchId, status: "validating" }, 202);
		}
		const batch = id ? batches.get(id) : undefined;
		if (!batch) return json({ error: { message: "not found" } }, 404);
		if (method === "DELETE") {
			batches.delete(id!);
			return json({ id, deletion: { openrouter: "deleted" } });
		}
		return json({ id, status: batch.status, results: batch.results, error: batch.error, usage: batch.results ? { cost: 0.0001 } : null });
	};
	/** Complete a batch; results come back reversed, `fail` marks requests as errors. */
	const complete = (id: string, fail: (customId: string) => boolean = () => false) => {
		const b = batches.get(id)!;
		b.status = "completed";
		b.results = b.body.requests
			.map((r) =>
				fail(r.custom_id)
					? { custom_id: r.custom_id, response: null, error: { message: "boom" } }
					: {
							custom_id: r.custom_id,
							error: null,
							response: {
								status_code: 200,
								body: { data: [{ object: "embedding", index: 0, embedding: vec(r.body.input) }] },
							},
						},
			)
			.reverse();
	};
	return { batches, calls, state, fetchFn, complete };
}

function setup(over: Record<string, unknown> = {}) {
	const or = stubOpenRouter();
	const clock = { t: 10_000_000 };
	const make = () =>
		createDocIndex({
			store: documentStore,
			embedder: () => null,
			batcher: () => openRouterBatchClient("key", MODEL, or.fetchFn),
			autoTick: false,
			now: () => clock.t,
			...over,
		});
	return { or, clock, make };
}

const pendingFile = () => documentStore.readPendingBatches();

describe("batch request building", () => {
	it("packs up to 64 texts per request with custom_id docId~offset", () => {
		const reqs = buildBatchRequests("doc_x", Array.from({ length: 150 }, (_, i) => `t${i}`));
		// One text per request (Vertex rejects multi-input embedding batches).
		assert.equal(reqs.length, 150);
		assert.deepEqual(reqs.slice(0, 2).map((r) => r.custom_id), ["doc_x~0", "doc_x~1"]);
		assert.equal(reqs[64]!.body.input, "t64");
		assert.equal(reqs[0]!.body.encoding_format, "float");
	});
});

describe("batch indexing", () => {
	it("debounces, submits one batch, polls once a minute, stores vectors under the base model, deletes the batch", async () => {
		const mutex = put("Mutex", MUTEX);
		const sema = put("Sema", SEMA);
		const { or, clock, make } = setup();
		const index = make();

		await index.tick(); // builds the index; the library just changed
		assert.deepEqual(or.calls, [], "debounce: nothing submitted yet");
		clock.t += 2 * MINUTE;
		await index.tick();
		assert.deepEqual(or.calls, ["POST create"]);
		const sent = or.batches.get("batch_1")!;
		assert.deepEqual([sent.body.endpoint, sent.body.model], ["/v1/embeddings", `${MODEL}:batch`]);
		assert.deepEqual(new Set(sent.body.requests.map((r) => r.custom_id.split("~")[0])), new Set([mutex.id, sema.id]));
		assert.deepEqual(pendingFile().map((p) => [p.batchId, p.model, Object.keys(p.docs).sort()]), [["batch_1", MODEL, [mutex.id, sema.id].sort()]]);
		assert.equal(pendingFile()[0]!.docs[mutex.id]!.units, JSON.parse(JSON.stringify(sent.body.requests)).filter((r: BatchRequest) => r.custom_id.startsWith(mutex.id)).length);
		assert.match([...scanRows().values()].map((r) => r.title).join(), /Indexing documents \(batch\) · waiting for OpenRouter · 2 documents/);

		await index.tick(); // same minute: no poll, and the documents are not submitted twice
		assert.deepEqual(or.calls, ["POST create"]);
		clock.t += MINUTE;
		sent.status = "in_progress";
		await index.tick();
		assert.deepEqual(or.calls, ["POST create", "GET batch_1"]);
		assert.equal(documentStore.readVectors(mutex.id), null);

		or.complete("batch_1");
		clock.t += MINUTE;
		await index.tick();
		assert.deepEqual(or.calls.slice(2), ["GET batch_1", "DELETE batch_1"]);
		const stored = documentStore.readVectors(mutex.id)!;
		assert.deepEqual([stored.model, stored.dims, stored.chunks.length], [MODEL, 3, sent.body.requests.filter((r) => r.custom_id.startsWith(mutex.id)).length]);
		const norm = Math.hypot(...stored.vectors.subarray(0, 3));
		assert.ok(Math.abs(norm - 1) < 1e-5, "L2-normalised");
		assert.equal(documentStore.readVectors(sema.id)?.model, MODEL);
		assert.deepEqual(pendingFile(), []);
		assert.equal(or.batches.size, 0, "deleted at OpenRouter");
		assert.deepEqual([...scanRows().values()], [], "the activity row is gone");
		assert.equal(or.state.submits.length, 1);
	});

	it("a failed request leaves its document for the next batch", async () => {
		const mutex = put("Mutex", MUTEX);
		const sema = put("Sema", SEMA);
		const { or, clock, make } = setup();
		const index = make();
		await index.tick();
		clock.t += 2 * MINUTE;
		await index.tick();
		or.complete("batch_1", (id) => id === `${mutex.id}~0`);
		clock.t += MINUTE;
		await index.tick();
		assert.equal(documentStore.readVectors(sema.id)?.model, MODEL);
		assert.equal(documentStore.readVectors(mutex.id), null);
		assert.deepEqual(or.state.submits, ["batch_1", "batch_2"]);
		assert.deepEqual(Object.keys(pendingFile()[0]!.docs), [mutex.id], "only the failed document is resubmitted");
	});

	it("a failed batch backs off ten minutes, then resubmits", async () => {
		const sema = put("Sema", SEMA);
		const { or, clock, make } = setup();
		const index = make();
		await index.tick();
		clock.t += 2 * MINUTE;
		await index.tick();
		const b = or.batches.get("batch_1")!;
		b.status = "failed";
		b.error = { message: "Batch request 'x' contains unsupported content." };
		clock.t += MINUTE;
		await index.tick();
		assert.deepEqual(pendingFile(), []);
		assert.equal(or.batches.has("batch_1"), false, "deleted");
		assert.equal(or.state.submits.length, 1, "backing off");
		clock.t += 5 * MINUTE;
		await index.tick();
		assert.equal(or.state.submits.length, 1);
		clock.t += 6 * MINUTE;
		await index.tick();
		assert.deepEqual(or.state.submits, ["batch_1", "batch_2"]);
		assert.deepEqual(Object.keys(pendingFile()[0]!.docs), [sema.id]);
	});

	it("pending batches survive a restart", async () => {
		const sema = put("Sema", SEMA);
		const { or, clock, make } = setup();
		const first = make();
		await first.tick();
		clock.t += 2 * MINUTE;
		await first.tick();
		or.complete("batch_1");

		clock.t += MINUTE;
		const second = make(); // a new process: only the store remembers
		await second.tick();
		assert.equal(documentStore.readVectors(sema.id)?.model, MODEL);
		assert.deepEqual(or.state.submits, ["batch_1"], "resumed, not resubmitted");
		assert.deepEqual(pendingFile(), []);
	});

	it("discards results for a document that changed while pending", async () => {
		const sema = put("Sema", SEMA);
		const { or, clock, make } = setup();
		const index = make();
		await index.tick();
		clock.t += 2 * MINUTE;
		await index.tick();
		const text = "# Ersatz\n\nGanz anderer Text über Graphen.";
		const fp = fingerprint(text);
		documentStore.save({ ...sema, contentHash: fp.contentHash, sections: fp.sections }, text);
		index.indexDocument(sema.id);
		or.complete("batch_1");
		clock.t += MINUTE;
		await index.tick();
		assert.equal(documentStore.readVectors(sema.id), null, "stale vectors were not written");
		assert.deepEqual(pendingFile(), []);
		assert.equal(or.batches.size, 0);
		clock.t += 2 * MINUTE; // the new text is picked up by the next batch
		await index.tick();
		assert.equal(or.state.submits.length, 2);
	});

	it("splits a batch the API answers 413 to", async () => {
		const mutex = put("Mutex", MUTEX);
		const sema = put("Sema", SEMA);
		const { or, clock, make } = setup();
		or.state.maxDocs = 1; // the provider's cap fits one document's requests, not two
		const index = make();
		await index.tick();
		clock.t += 2 * MINUTE;
		await index.tick();
		assert.equal(or.state.submits.length, 2);
		assert.deepEqual(pendingFile().map((p) => Object.keys(p.docs)).sort(), [[mutex.id], [sema.id]].sort());
	});

	it("says so on 402 and 429 instead of crashing, and retries later", async () => {
		const sema = put("Sema", SEMA);
		const { or, clock, make } = setup();
		const index = make();
		await index.tick();
		clock.t += 2 * MINUTE;
		or.state.submitStatus = 402;
		await index.tick();
		assert.match([...scanRows().values()].map((r) => r.title).join(), /balance too low/);
		assert.deepEqual(pendingFile(), []);
		or.state.submitStatus = 429;
		clock.t += 10 * MINUTE + 1;
		await index.tick();
		assert.match([...scanRows().values()].map((r) => r.title).join(), /rate limited/);
		or.state.submitStatus = 0;
		clock.t += MINUTE;
		await index.tick();
		assert.deepEqual(Object.keys(pendingFile()[0]!.docs), [sema.id]);
		assert.equal(or.state.submits.length, 1);
	});

	it("embeddingBatch=false keeps the synchronous path", async () => {
		const sema = put("Sema", SEMA);
		const { or, make } = setup({
			batchMode: () => false,
			autoTick: undefined,
			embedder: () => ({ model: MODEL, embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) }),
		});
		const index = make();
		await index.search({ query: "Semaphoren" });
		const t0 = Date.now();
		while (documentStore.readVectors(sema.id) === null) {
			if (Date.now() - t0 > 3000) throw new Error("timeout");
			await new Promise((r) => setTimeout(r, 10));
		}
		assert.deepEqual(or.calls, [], "no batch request");
	});
});

describe("concepts through the batch path", () => {
	const node = (id: string, name: string, statement: string): GraphNode => ({
		id,
		name,
		statement,
		aliases: [],
		createdAt: "2026-10-01T00:00:00.000Z",
		provenance: [],
	});
	const nodes = [node("n_aaaaaa1", "Semaphore P/V atomic", "P und V sind atomar."), node("n_bbbbbb2", "Mutex lock", "Ein Mutex schützt.")];
	const graph = { readNodes: () => nodes, readTopics: () => [], readTopicAliases: () => ({}) };

	it("concept vectors survive a restart", async () => {
		const { or, clock, make } = setup({ graphStore: graph, graphStamp: () => "1", conceptVectors: conceptVectorStore });
		const first = make();
		await first.tick();
		clock.t += 2 * MINUTE;
		await first.tick();
		const sent = or.batches.get("batch_1")!;
		assert.deepEqual(sent.body.requests.map((r) => r.custom_id).sort(), ["cpt_n_aaaaaa1~0", "cpt_n_bbbbbb2~0"]);
		assert.equal(sent.body.requests.find((r) => r.custom_id === "cpt_n_bbbbbb2~0")!.body.input, "Mutex lock\nEin Mutex schützt.");
		assert.deepEqual(Object.keys(pendingFile()[0]!.docs).sort(), ["cpt_n_aaaaaa1", "cpt_n_bbbbbb2"]);

		or.complete("batch_1");
		clock.t += MINUTE;
		await first.tick();
		const stored = conceptVectorStore.read()!;
		assert.deepEqual([stored.model, stored.dims, Object.keys(stored.entries).sort()], [MODEL, 3, ["cpt_n_aaaaaa1", "cpt_n_bbbbbb2"]]);
		assert.deepEqual(pendingFile(), []);

		const second = make(); // a new process on the same data dir
		clock.t += 10 * MINUTE;
		await second.tick();
		clock.t += 10 * MINUTE;
		await second.tick();
		assert.deepEqual(or.state.submits, ["batch_1"], "no new batch for concepts that already have vectors");
	});

	it("an edited concept is resubmitted alone", async () => {
		const live = [...nodes];
		const g = { ...graph, readNodes: () => live };
		let stamp = 1;
		const { or, clock, make } = setup({ graphStore: g, graphStamp: () => String(stamp), conceptVectors: conceptVectorStore });
		const index = make();
		await index.tick();
		clock.t += 2 * MINUTE;
		await index.tick();
		or.complete("batch_1");
		clock.t += MINUTE;
		await index.tick();
		live[1] = node("n_bbbbbb2", "Mutex lock", "Ein Mutex sperrt.");
		stamp++;
		clock.t += 3 * MINUTE;
		await index.tick();
		clock.t += 3 * MINUTE;
		await index.tick();
		assert.deepEqual(or.batches.get("batch_2")!.body.requests.map((r) => r.custom_id), ["cpt_n_bbbbbb2~0"]);
	});
});
