/**
 * Hybrid document search end to end (PR I), no network: the vector files
 * round-trip through the real DocumentStore under an isolated LH_DATA_DIR,
 * the index ranks with an injected stub embedder (hybrid) and degrades to
 * BM25 honestly when it fails, the three document tools read the same store,
 * and a scripted teacher session searches then reads. The settings gate and
 * the registry wiring are pinned at the end.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-index-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { documentStore } = await import("../src/store/documents.ts");
const { createDocIndex } = await import("../src/server/doc-index.ts");
const { fingerprint } = await import("../src/core/documents.ts");
const { documentTools } = await import("../src/agent/tools/documents.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { documentToolsEnabled, resolveSettings } = await import("../src/core/settings-resolution.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { parseAgentSettingsBody, parseDocumentsSettingsBody } = await import("../src/server/settings-body.ts");
import type { Embedder } from "../src/server/doc-index.ts";
import type { DocumentMeta } from "../src/core/contracts/documents.ts";
import type { PiEngine } from "../src/agent/models.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(TMP_DATA, "documents"), { recursive: true, force: true }));

// ── fixtures ─────────────────────────────────────────────────────────────────

const para = (n: number, w: string) => Array.from({ length: n }, () => w).join(" ");

const MUTEX = [
	"<!-- page 1 -->",
	"# Mutex",
	"",
	"Ein Mutex schützt einen kritischen Abschnitt vor gleichzeitigem Zugriff.",
	"",
	"<!-- page 2 -->",
	"## Aufgabe 3",
	"",
	"Warum braucht lock() ein unlock()? Begründe mit dem Abschnitt.",
	"",
	"<!-- page 3 -->",
	para(300, "füllwort"),
].join("\n");

const SEMA = [
	"<!-- page 1 -->",
	"# Semaphoren",
	"",
	"Semaphoren zählen freie Ressourcen. wait verringert, signal erhöht den Zähler.",
].join("\n");

let counter = 0;
function put(title: string, markdown: string, topics: string[] = []): DocumentMeta {
	const fp = fingerprint(markdown);
	const id = `doc_${String(++counter).padStart(12, "0")}`;
	const meta: DocumentMeta = {
		id,
		contentHash: fp.contentHash,
		minhash: fp.minhash,
		title,
		summary: "",
		topics,
		filenames: ["x.md"],
		importedAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		pages: 3,
		origin: "markdown",
		sections: fp.sections,
		sourceId: id,
	};
	documentStore.save(meta, markdown);
	return meta;
}

/** Concept axes: the stub "understands" that Sperre ~ Mutex ~ lock and
 *  Zähler ~ Semaphor, which no keyword overlap could know. */
const CONCEPTS = [["mutex", "sperre", "lock", "abschnitt"], ["semaphor", "zähler", "counter"]];
function stubEmbedder(model = "stub-1", over: Partial<Embedder> = {}): Embedder & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		model,
		calls,
		async embed(texts) {
			calls.push(texts);
			return texts.map((t) => {
				const low = t.toLowerCase();
				return Float32Array.from([...CONCEPTS.map((words) => words.filter((w) => low.includes(w)).length), 0.01]);
			});
		},
		...over,
	};
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};

// ── the store ────────────────────────────────────────────────────────────────

describe("DocumentStore vectors", () => {
	const vectors = (meta: DocumentMeta) => ({
		model: "m",
		dims: 3,
		contentHash: meta.contentHash,
		chunks: [
			{ sectionId: "s1", start: 0, end: 10, pageFrom: 1, pageTo: 1 },
			{ sectionId: "s2", start: 10, end: 20 },
		],
		vectors: Float32Array.from([1, 0.5, -2, 0.25, 3, 0]),
	});

	it("round-trips little-endian float32 + chunks.json", () => {
		const meta = put("A", MUTEX);
		documentStore.writeVectors(meta.id, vectors(meta));
		const back = documentStore.readVectors(meta.id)!;
		assert.deepEqual([back.model, back.dims, back.chunks.length], ["m", 3, 2]);
		assert.deepEqual([...back.vectors], [1, 0.5, -2, 0.25, 3, 0]);
		const raw = fs.readFileSync(path.join(TMP_DATA, "documents", meta.id, "vectors.f32"));
		assert.equal(raw.length, 6 * 4);
		assert.equal(raw.readFloatLE(0), 1);
		assert.equal(raw.readFloatLE(8), -2);
	});

	it("reads as absent when stale (text changed) or torn (short file)", () => {
		const meta = put("A", MUTEX);
		documentStore.writeVectors(meta.id, vectors(meta));
		fs.truncateSync(path.join(TMP_DATA, "documents", meta.id, "vectors.f32"), 8);
		assert.equal(documentStore.readVectors(meta.id), null);
		documentStore.writeVectors(meta.id, vectors(meta));
		documentStore.save({ ...meta, contentHash: "other" }, MUTEX);
		assert.equal(documentStore.readVectors(meta.id), null, "computed from other text");
	});
});

// ── the index ────────────────────────────────────────────────────────────────

describe("keyword mode (no embeddings)", () => {
	it("ranks by BM25 and says it is keyword-only, with title, heading path, page and snippet", async () => {
		const mutex = put("Betriebssysteme Blatt 7", MUTEX, ["Mutex"]);
		put("Blatt 8", SEMA, ["Semaphoren"]);
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		const r = await index.search({ query: "Aufgabe 3 lock unlock" });
		assert.equal(r.mode, "keyword");
		assert.match(r.note ?? "", /Keyword search only/);
		const top = r.hits[0]!;
		assert.deepEqual([top.docId, top.title, top.headingPath, top.pageFrom, top.pageTo], [mutex.id, "Betriebssysteme Blatt 7", ["Mutex", "Aufgabe 3"], 2, 2]);
		assert.ok(top.snippet.includes("lock()") && top.snippet.length <= 340);
		assert.ok(top.score > 0);
	});

	it("filters by topic and by document (id or title part); unknown filters say so", async () => {
		const mutex = put("Betriebssysteme Blatt 7", MUTEX, ["Mutex"]);
		const sema = put("Blatt 8", SEMA, ["Semaphoren"]);
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		const docsOf = async (q: Parameters<typeof index.search>[0]) => [...new Set((await index.search(q)).hits.map((h) => h.docId))];
		assert.deepEqual(await docsOf({ query: "Ressourcen Zähler Mutex", topic: "semaphor" }), [sema.id]);
		assert.deepEqual(await docsOf({ query: "Mutex Zähler", document: "blatt 7" }), [mutex.id]);
		assert.deepEqual(await docsOf({ query: "Mutex", document: mutex.id }), [mutex.id]);
		const none = await index.search({ query: "Mutex", topic: "Graphen" });
		assert.deepEqual([none.hits.length, /No document matches/.test(none.note ?? "")], [0, true]);
	});

	it("picks up a stored or replaced document without a rebuild", async () => {
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		assert.equal((await index.search({ query: "Semaphoren" })).hits.length, 0);
		const meta = put("Blatt 8", SEMA);
		index.indexDocument(meta.id);
		assert.equal((await index.search({ query: "Semaphoren" })).hits[0]?.docId, meta.id);
		const fp = fingerprint("# Ersatz\n\nGanz anderer Text über Graphen.");
		documentStore.save({ ...meta, contentHash: fp.contentHash, sections: fp.sections }, "# Ersatz\n\nGanz anderer Text über Graphen.");
		index.indexDocument(meta.id);
		assert.equal((await index.search({ query: "Semaphoren" })).hits.length, 0, "old text is gone");
		assert.equal((await index.search({ query: "Graphen" })).hits[0]?.docId, meta.id);
	});
});

describe("hybrid mode (stub embedder)", () => {
	it("embeds in the background, persists vectors, and finds a synonym keywords cannot", async () => {
		const mutex = put("Betriebssysteme Blatt 7", MUTEX);
		put("Blatt 8", SEMA);
		const embedder = stubEmbedder();
		const index = createDocIndex({ store: documentStore, embedder: () => embedder });

		// First search never waits for the backfill; it is keyword-only and says why.
		const first = await index.search({ query: "Sperre" });
		assert.equal(first.mode, "keyword");
		assert.equal(first.hits.length, 0, "no keyword overlap with 'Sperre'");

		await waitFor(() => documentStore.readVectors(mutex.id) !== null);
		const stored = documentStore.readVectors(mutex.id)!;
		assert.deepEqual([stored.model, stored.dims], ["stub-1", 3]);

		const r = await index.search({ query: "Sperre" });
		assert.equal(r.mode, "hybrid");
		assert.equal(r.hits[0]?.docId, mutex.id, "the semantic leg found it");
		// The persisted vectors are reused by a fresh index: no new embedding calls for documents.
		const again = stubEmbedder();
		const fresh = createDocIndex({ store: documentStore, embedder: () => again });
		assert.equal((await fresh.search({ query: "Sperre" })).mode, "hybrid");
		assert.deepEqual(again.calls.map((c) => c.length), [1], "only the query was embedded");
	});

	it("falls back to keywords when the query embedding fails or hangs, and says so", async () => {
		const mutex = put("Blatt 7", MUTEX);
		const good = stubEmbedder();
		const index = createDocIndex({ store: documentStore, embedder: () => good, queryTimeoutMs: 30 });
		await index.search({ query: "x" });
		await waitFor(() => documentStore.readVectors(mutex.id) !== null);

		const broken = createDocIndex({
			store: documentStore,
			embedder: () => ({ model: "stub-1", embed: async () => { throw new Error("boom"); } }),
		});
		const failed = await broken.search({ query: "Mutex Abschnitt" });
		assert.equal(failed.mode, "keyword");
		assert.match(failed.note ?? "", /could not be embedded \(boom\)/);
		assert.equal(failed.hits[0]?.docId, mutex.id, "BM25 still answers");

		const hanging = createDocIndex({
			store: documentStore,
			embedder: () => ({ model: "stub-1", embed: () => new Promise<Float32Array[]>(() => {}) }),
			queryTimeoutMs: 30,
		});
		const t0 = Date.now();
		const slow = await hanging.search({ query: "Mutex" });
		assert.equal(slow.mode, "keyword");
		assert.ok(Date.now() - t0 < 1000, "a search never waits on embedding");
	});

	it("a failing backfill is contained: no vectors, search works, and it backs off instead of looping", async () => {
		const mutex = put("Blatt 7", MUTEX);
		let calls = 0;
		const index = createDocIndex({
			store: documentStore,
			embedder: () => ({ model: "m", embed: async () => { calls++; throw new Error("no credit"); } }),
		});
		for (let i = 0; i < 3; i++) assert.equal((await index.search({ query: "Mutex" })).hits[0]?.docId, mutex.id);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(documentStore.readVectors(mutex.id), null);
		assert.equal(calls, 1, "one attempt, then backoff");
	});

	it("a changed embedding model ignores old vectors until the library is re-embedded", async () => {
		const mutex = put("Blatt 7", MUTEX);
		const one = createDocIndex({ store: documentStore, embedder: () => stubEmbedder("m1") });
		await one.search({ query: "x" });
		await waitFor(() => documentStore.readVectors(mutex.id)?.model === "m1");

		const two = stubEmbedder("m2");
		const index = createDocIndex({ store: documentStore, embedder: () => two });
		const r = await index.search({ query: "Sperre" });
		assert.equal(r.mode, "keyword", "m1 vectors are not comparable with an m2 query");
		await waitFor(() => documentStore.readVectors(mutex.id)?.model === "m2");
		assert.equal((await index.search({ query: "Sperre" })).mode, "hybrid");
	});
});

// ── the tools ────────────────────────────────────────────────────────────────

describe("document tools", () => {
	const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
	const run = async (tools: ReturnType<typeof documentTools>, name: string, args: object) =>
		(await tools[name]!.execute("call-1", args as never, undefined as never)) as { content: { type: string; text?: string }[]; details: any };

	it("search then read returns the exact stored text with page markers", async () => {
		const mutex = put("Betriebssysteme Blatt 7", MUTEX, ["Mutex"]);
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		const tools = documentTools(index);

		const found = await run(tools, "search_documents", { query: "unlock Aufgabe 3" });
		assert.match(textOf(found), /keyword only/);
		assert.match(textOf(found), new RegExp(`Betriebssysteme Blatt 7 · § Mutex > Aufgabe 3 · p\\.2[\\s\\S]*docId ${mutex.id} · section s2`));
		assert.equal(found.details.kind, "search");
		assert.deepEqual([found.details.hits[0].docId, found.details.hits[0].pageFrom], [mutex.id, 2]);

		const read = await run(tools, "read_document", { document: mutex.id, section: "s2" });
		const stored = fs.readFileSync(path.join(TMP_DATA, "documents", mutex.id, "document.md"), "utf-8");
		const s2 = mutex.sections[1]!;
		assert.ok(textOf(read).includes(`<!-- page 2 -->\n${stored.slice(s2.start, s2.end)}`), "exact text, page marker kept");
		assert.deepEqual([read.details.kind, read.details.ok, read.details.pageFrom], ["read", true, 2]);

		const byPages = await run(tools, "read_document", { document: "blatt 7", pages: "2" });
		assert.ok(textOf(byPages).includes("Warum braucht lock()") && !textOf(byPages).includes("kritischen Abschnitt"));
	});

	it("caps a long read at about 12k chars and tells where to continue", async () => {
		const big = put("Groß", `<!-- page 1 -->\n# Groß\n\n${Array.from({ length: 400 }, (_, i) => `Absatz ${i}: ${para(25, "wort")}`).join("\n\n")}`);
		const tools = documentTools(createDocIndex({ store: documentStore, embedder: () => null }));
		const first = await run(tools, "read_document", { document: big.id, pages: "1" });
		const body = textOf(first);
		assert.ok(body.length < 12_300);
		const next = /offset=(\d+)/.exec(body)![1]!;
		assert.equal(first.details.truncated, true);
		const second = await run(tools, "read_document", { document: big.id, pages: "1", offset: Number(next) });
		assert.ok(textOf(second).includes("Absatz") && !textOf(second).startsWith(body.slice(0, 80)));
	});

	it("lists documents, answers misses plainly, and without a selector gives the outline", async () => {
		const mutex = put("Betriebssysteme Blatt 7", MUTEX, ["Mutex"]);
		put("Blatt 8", SEMA, ["Semaphoren"]);
		const tools = documentTools(createDocIndex({ store: documentStore, embedder: () => null }));
		const all = textOf(await run(tools, "list_documents", {}));
		assert.match(all, /2 document\(s\)/);
		assert.match(all, new RegExp(`Betriebssysteme Blatt 7 · topics: Mutex · 3 pages · docId ${mutex.id}`));
		assert.match(textOf(await run(tools, "list_documents", { topic: "Graphen" })), /No documents tagged "Graphen"/);
		assert.match(textOf(await run(tools, "read_document", { document: mutex.id })), /s2 · Mutex > Aufgabe 3 · p\.2/);
		assert.match(textOf(await run(tools, "read_document", { document: "gibt es nicht" })), /No document matches/);
		assert.match(textOf(await run(tools, "read_document", { document: "blatt" })), /matches 2 documents/);
	});
});

// ── a scripted teacher session ───────────────────────────────────────────────

describe("a teacher session with the document tools", () => {
	it("searches, reads, and answers from the result the tools returned", async () => {
		const mutex = put("Betriebssysteme Blatt 7", MUTEX);
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		const seen: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_documents", { query: "Aufgabe 3 lock" }, { id: "c1" })], { stopReason: "toolUse" }),
			(context) => {
				seen.push(JSON.stringify(context.messages.at(-1)));
				return fauxAssistantMessage([fauxToolCall("read_document", { document: mutex.id, section: "s2" }, { id: "c2" })], { stopReason: "toolUse" });
			},
			(context) => {
				seen.push(JSON.stringify(context.messages.at(-1)));
				return fauxAssistantMessage([fauxText("Aufgabe 3 fragt nach lock() und unlock() (Betriebssysteme Blatt 7, p. 2).")]);
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const agent = createTeacherAgent(undefined, { engine, tools: documentTools(index) });
		await agent.prompt("Hilf mir mit Aufgabe 3.");

		assert.match(seen[0]!, new RegExp(`docId ${mutex.id} · section s2`), "the search result reached the model");
		assert.match(seen[1]!, /Warum braucht lock\(\) ein unlock\(\)/, "the read result reached the model");
		const results = agent.state.messages.filter((m) => m.role === "toolResult") as unknown as { toolName: string; details: { kind: string } }[];
		assert.deepEqual(results.map((r) => [r.toolName, r.details.kind]), [["search_documents", "search"], ["read_document", "read"]]);
		const last = agent.state.messages.at(-1) as { content: { text?: string }[] };
		assert.match(last.content[0]!.text ?? "", /p\. 2/);
	});
});

// ── the gate and the wiring ──────────────────────────────────────────────────

describe("agent.documentTools", () => {
	const deps = documentTools(createDocIndex({ store: documentStore, embedder: () => null }));
	const names = Object.keys(deps);
	const chatStore = { getChat: () => null } as never;
	const jobStore = {} as never;
	const docs = { search: async () => ({ mode: "keyword" as const, query: "", hits: [] }), read: () => ({ ok: false as const, error: "" }), list: () => [] };

	it("defaults on, and the setting turns it off", () => {
		assert.equal(documentToolsEnabled(resolveSettings(null)), true);
		assert.equal(documentToolsEnabled(resolveSettings({ version: 1, agent: { documentTools: { enabled: false } } })), false);
		assert.deepEqual(sanitizeUserSettings({ version: 1, agent: { documentTools: { enabled: false } } })?.agent?.documentTools, { enabled: false });
		assert.equal(parseAgentSettingsBody({ documentTools: { enabled: "no" } }).ok, false);
	});

	it("prober, teacher and practice carry the three tools only when the context passes them", () => {
		const base = { chatId: "c", chatStore, jobStore, spawn: () => {} };
		for (const make of [
			(documents?: typeof docs) => createProberTools({ ...base, ...(documents ? { documents } : {}) } as never),
			(documents?: typeof docs) => createTeacherTools({ ...base, ...(documents ? { documents } : {}) } as never),
			(documents?: typeof docs) => practiceTools({ chatId: "c", chatStore, ...(documents ? { documents } : {}) } as never),
		]) {
			const on = Object.keys(make(docs));
			const off = Object.keys(make());
			for (const name of names) assert.ok(on.includes(name) && !off.includes(name), name);
		}
	});

	it("the embedding model setting: default, strict write, lenient read", () => {
		assert.equal(resolveSettings(null).documents.embeddingModel, "google/gemini-embedding-2");
		assert.equal(resolveSettings(null).documents.embeddingBatch, true);
		assert.equal(resolveSettings({ version: 1, documents: { embeddingBatch: false } }).documents.embeddingBatch, false);
		assert.equal(parseDocumentsSettingsBody({ embeddingBatch: "yes" }).ok, false);
		assert.deepEqual(parseDocumentsSettingsBody({ embeddingBatch: false }), { ok: true, settings: { embeddingBatch: false } });
		assert.deepEqual(sanitizeUserSettings({ version: 1, documents: { embeddingBatch: "x" } })?.documents, {});
		assert.equal(resolveSettings({ version: 1, documents: { embeddingModel: "openai/text-embedding-3-small" } }).documents.embeddingModel, "openai/text-embedding-3-small");
		assert.deepEqual(parseDocumentsSettingsBody({ embeddingModel: " baai/bge-m3 " }), { ok: true, settings: { embeddingModel: "baai/bge-m3" } });
		assert.deepEqual(parseDocumentsSettingsBody({}), { ok: true, settings: {} });
		assert.equal(parseDocumentsSettingsBody({ embeddingModel: "not a model" }).ok, false);
		assert.deepEqual(sanitizeUserSettings({ version: 1, documents: { embeddingModel: "junk" } })?.documents, {});
	});
});

describe("openRouterEmbedder retries", () => {
	it("retries a 429 (honouring Retry-After) and then succeeds", async () => {
		const { openRouterEmbedder, retryDelayMs } = await import("../src/server/doc-index.ts");
		assert.equal(retryDelayMs(0, "0"), 0);
		let calls = 0;
		const fetchFn = (async () => {
			calls++;
			if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
			return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
		}) as unknown as typeof fetch;
		const out = await openRouterEmbedder("k", "m", fetchFn).embed(["x"]);
		assert.equal(calls, 2);
		assert.equal(out[0]!.length, 2);
	});
	it("does not retry a 400", async () => {
		const { openRouterEmbedder } = await import("../src/server/doc-index.ts");
		let calls = 0;
		const fetchFn = (async () => {
			calls++;
			return new Response("bad", { status: 400 });
		}) as unknown as typeof fetch;
		await assert.rejects(openRouterEmbedder("k", "m", fetchFn).embed(["x"]), /400/);
		assert.equal(calls, 1);
	});
});
