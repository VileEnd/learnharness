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
const { conceptVectorStore } = await import("../src/store/concept-vectors.ts");
const { renderOkfBundle, conceptPath } = await import("../src/core/okf.ts");
const { createHash } = await import("node:crypto");
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
import type { GraphNode } from "../src/core/contracts/graph.ts";
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
		sourceId: `src_${id}`, // the graph source id differs from the docId, as in the app
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
		assert.deepEqual([none.hits.length, /Nothing matches/.test(none.note ?? "")], [0, true]);
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

// ── the tool ─────────────────────────────────────────────────────────────────

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
const run = async (tools: ReturnType<typeof documentTools>, name: string, args: object) =>
	(await tools[name]!.execute("call-1", args as never, undefined as never)) as { content: { type: string; text?: string }[]; details: any };

describe("document tools", () => {
	it("only search_documents remains", () => {
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		assert.deepEqual(Object.keys(documentTools(index)), ["search_documents"]);
	});

	it("search names the bundle file of every hit and keeps the ids beside it", async () => {
		const mutex = put("Betriebssysteme Blatt 7", MUTEX, ["Mutex"]);
		const tools = documentTools(createDocIndex({ store: documentStore, embedder: () => null }));
		const found = await run(tools, "search_documents", { query: "unlock Aufgabe 3" });
		assert.match(textOf(found), /keyword only/);
		assert.match(textOf(found), /Betriebssysteme Blatt 7 · § Mutex > Aufgabe 3 · p\.2\n   documents\/.+\/s2-aufgabe-3\.md/);
		assert.equal(found.details.kind, "search");
		const hit = found.details.hits[0];
		assert.deepEqual([hit.kind, hit.docId, hit.sectionId, hit.pageFrom], ["section", mutex.id, "s2", 2]);
		assert.match(hit.path, /^documents\/.+\/s2-aufgabe-3\.md$/);
	});
});

// ── bundle paths and concepts ────────────────────────────────────────────────

describe("search hits carry their bundle path", () => {
	it("section hits carry their bundle path", async () => {
		put("Betriebssysteme Blatt 7", MUTEX);
		const r = await createDocIndex({ store: documentStore, embedder: () => null }).search({ query: "unlock Aufgabe 3" });
		assert.match(r.hits[0]!.path, /^documents\/.+\/s\d+-.+\.md$/);
		assert.equal(r.hits[0]!.kind, "section");
	});

	it("the path is the file the bundle renderer writes (incl. colliding titles and umlauts)", async () => {
		const a = put("Übung: C++ & Mutex", MUTEX);
		const b = put("Übung: C++ & Mutex", SEMA);
		const metas = [a, b];
		const bundle = renderOkfBundle({
			nodes: [],
			chains: [],
			topics: [],
			aliases: {},
			documents: metas.map((meta) => ({ meta, text: documentStore.readMarkdown(meta.id)! })),
			noteSources: [],
			chats: [],
			gates: { documents: true, graph: true },
			now: "2026-10-25T00:00:00.000Z",
		});
		const files = new Set(bundle.map((f) => f.path));
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		const hits = [...(await index.search({ query: "Mutex Semaphoren Aufgabe", limit: 20 })).hits];
		assert.ok(hits.length >= 2);
		for (const h of hits) assert.ok(files.has(h.path), `${h.path} is a bundle file`);
	});
});

const NODE_A: GraphNode = {
	id: "n_aaaaaa1",
	name: "Semaphore P/V atomic",
	statement: "Die Operationen P und V einer Semaphore sind atomar.",
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId: "chat_1", messageId: "m1" }],
};
const NODE_B: GraphNode = {
	id: "n_bbbbbb2",
	name: "Mutex lock",
	statement: "Ein Mutex schützt einen kritischen Abschnitt.",
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId: "DOC", messageId: "", section: "s1" }],
};

function fakeGraph(nodes: GraphNode[], topics: { nodeId: string; topic: string }[] = [], aliases: Record<string, string> = {}) {
	const g = {
		nodes,
		topics,
		aliases,
		version: 0,
		readNodes: () => g.nodes,
		readTopics: () => g.topics.map((t) => ({ ...t, sourceId: "x", at: "2026-10-01T00:00:00.000Z" })),
		readTopicAliases: () => g.aliases,
		stamp: () => String(g.version),
	};
	return g;
}

describe("concepts as search units", () => {
	beforeEach(() => fs.rmSync(path.join(TMP_DATA, "graph"), { recursive: true, force: true }));

	it("search returns concept hits with paths", async () => {
		const g = fakeGraph([NODE_A]);
		const index = createDocIndex({ store: documentStore, embedder: () => null, graphStore: g, graphStamp: g.stamp });
		const r = await index.search({ query: "atomar semaphore" });
		const hit = r.hits[0]!;
		assert.equal(hit.kind, "concept");
		assert.match(hit.path, /^concepts\//);
		assert.equal(hit.conceptId, NODE_A.id);
		assert.deepEqual([hit.docId, hit.sectionId, hit.title], ["", "", "Semaphore P/V atomic"]);
		assert.equal(hit.path, conceptPath(NODE_A));
	});

	it("picks up a new concept when nodes.jsonl changes, and drops a removed one", async () => {
		const g = fakeGraph([NODE_A]);
		const index = createDocIndex({ store: documentStore, embedder: () => null, graphStore: g, graphStamp: g.stamp });
		assert.equal((await index.search({ query: "kritischen Abschnitt" })).hits.length, 0);
		g.nodes = [NODE_A, NODE_B];
		g.version++;
		assert.equal((await index.search({ query: "kritischen Abschnitt" })).hits[0]?.conceptId, NODE_B.id);
		g.nodes = [NODE_B];
		g.version++;
		assert.deepEqual((await index.search({ query: "Semaphore atomar" })).hits, []);
	});

	it("graph gate off: no concept hits; includeConcepts false: passages only", async () => {
		put("Blatt 8", SEMA, ["Semaphoren"]);
		const g = fakeGraph([NODE_A]);
		let on = true;
		const index = createDocIndex({ store: documentStore, embedder: () => null, graphStore: g, graphStamp: g.stamp, conceptsEnabled: () => on });
		assert.ok((await index.search({ query: "Semaphore" })).hits.some((h) => h.kind === "concept"));
		assert.ok((await index.search({ query: "Semaphore", includeConcepts: false })).hits.every((h) => h.kind === "section"));
		on = false;
		assert.ok((await index.search({ query: "Semaphore" })).hits.every((h) => h.kind === "section"));
	});

	it("filters: topic uses topics.jsonl and aliases; document keeps only concepts born in that document", async () => {
		const doc = put("Blatt 7", MUTEX, ["Mutex"]);
		const g = fakeGraph(
			[NODE_A, { ...NODE_B, provenance: [{ chatId: doc.sourceId, messageId: "", section: "s1" }] }],
			[
				{ nodeId: NODE_A.id, topic: "Sema" },
				{ nodeId: NODE_B.id, topic: "Locks" },
			],
			{ locks: "Sperren" },
		);
		const index = createDocIndex({ store: documentStore, embedder: () => null, graphStore: g, graphStamp: g.stamp });
		const conceptsOf = async (q: Parameters<typeof index.search>[0]) =>
			(await index.search({ ...q, limit: 20 })).hits.flatMap((h) => (h.conceptId ? [h.conceptId] : []));
		assert.deepEqual((await conceptsOf({ query: "Semaphore Mutex Abschnitt atomar" })).sort(), [NODE_A.id, NODE_B.id]);
		assert.deepEqual(await conceptsOf({ query: "Semaphore Mutex Abschnitt atomar", topic: "sperren" }), [NODE_B.id], "alias-folded topic");
		assert.deepEqual(await conceptsOf({ query: "Semaphore Mutex Abschnitt atomar", topic: "Sema" }), [NODE_A.id]);
		assert.deepEqual(await conceptsOf({ query: "Semaphore Mutex Abschnitt atomar", document: "Blatt 7" }), [NODE_B.id], "A came from a chat, not this document");
	});

	it("embeds concepts on the sync path, persists them, and reuses them after a restart", async () => {
		const g = fakeGraph([NODE_A, NODE_B]);
		const embedder = stubEmbedder("stub-1");
		const make = () =>
			createDocIndex({ store: documentStore, embedder: () => embedder, graphStore: g, graphStamp: g.stamp, conceptVectors: conceptVectorStore, batchPauseMs: 0 });
		const first = make();
		await first.search({ query: "Sperre" });
		await waitFor(() => conceptVectorStore.read() !== null);
		const stored = conceptVectorStore.read()!;
		assert.deepEqual([stored.model, stored.dims, Object.keys(stored.entries).sort()], ["stub-1", 3, [`cpt_${NODE_A.id}`, `cpt_${NODE_B.id}`]]);
		assert.equal(stored.entries[`cpt_${NODE_A.id}`]!.contentHash, createHash("sha256").update(NODE_A.name + NODE_A.statement).digest("hex"));
		const callsBefore = embedder.calls.flat().filter((t) => t.includes("Semaphore")).length;

		const second = make(); // a new process: only the store remembers
		const r = await second.search({ query: "Sperre" });
		assert.equal(r.mode, "hybrid");
		assert.equal(r.hits[0]?.conceptId, NODE_B.id, "the semantic leg found the concept keywords cannot");
		await new Promise((res) => setTimeout(res, 50));
		assert.equal(embedder.calls.flat().filter((t) => t.includes("Semaphore")).length, callsBefore, "no concept was embedded again");
	});

	it("re-embeds only a changed concept, and everything when the model changes", async () => {
		const g = fakeGraph([NODE_A, NODE_B]);
		let embedder = stubEmbedder("stub-1");
		const index = createDocIndex({ store: documentStore, embedder: () => embedder, graphStore: g, graphStamp: g.stamp, conceptVectors: conceptVectorStore, batchPauseMs: 0 });
		await index.search({ query: "x y" });
		await waitFor(() => conceptVectorStore.read() !== null);
		embedder.calls.length = 0;

		g.nodes = [NODE_A, { ...NODE_B, statement: "Ein Mutex sperrt einen Abschnitt." }];
		g.version++;
		await index.search({ query: "x y" });
		await waitFor(() => embedder.calls.flat().some((t) => t.includes("sperrt")));
		await new Promise((res) => setTimeout(res, 30));
		assert.deepEqual(embedder.calls.flat().filter((t) => t.includes("\n")).length, 1, "only the edited concept");

		embedder = stubEmbedder("stub-2");
		embedder.calls.length = 0;
		await index.search({ query: "x y" });
		await waitFor(() => embedder.calls.flat().filter((t) => t.includes("\n")).length === 2);
		await waitFor(() => conceptVectorStore.read()?.model === "stub-2");
	});
});

describe("ConceptVectorStore", () => {
	beforeEach(() => fs.rmSync(path.join(TMP_DATA, "graph"), { recursive: true, force: true }));

	it("round-trips float32 and reads as absent when torn, corrupt or missing", () => {
		assert.equal(conceptVectorStore.read(), null);
		conceptVectorStore.write({ model: "m", dims: 2, entries: { cpt_a: { contentHash: "h", offset: 0 }, cpt_b: { contentHash: "i", offset: 1 } }, vectors: Float32Array.from([1, 0.5, -2, 0.25]) });
		const back = conceptVectorStore.read()!;
		assert.deepEqual([back.model, back.dims, [...back.vectors], back.entries.cpt_b!.offset], ["m", 2, [1, 0.5, -2, 0.25], 1]);
		fs.truncateSync(path.join(TMP_DATA, "graph", "concept-vectors.f32"), 8);
		assert.equal(conceptVectorStore.read(), null, "an entry points past the vectors");
		fs.writeFileSync(path.join(TMP_DATA, "graph", "concept-vectors.json"), "{nope");
		assert.equal(conceptVectorStore.read(), null);
	});
});

// ── a scripted teacher session ───────────────────────────────────────────────

describe("a teacher session with the search tool", () => {
	it("searches and answers from the result the tool returned", async () => {
		put("Betriebssysteme Blatt 7", MUTEX);
		const index = createDocIndex({ store: documentStore, embedder: () => null });
		const seen: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_documents", { query: "Aufgabe 3 lock" }, { id: "c1" })], { stopReason: "toolUse" }),
			(context) => {
				seen.push(JSON.stringify(context.messages.at(-1)));
				return fauxAssistantMessage([fauxText("Aufgabe 3 fragt nach lock() und unlock() (Betriebssysteme Blatt 7, p. 2).")]);
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const agent = createTeacherAgent(undefined, { engine, tools: documentTools(index) });
		await agent.prompt("Hilf mir mit Aufgabe 3.");

		assert.match(seen[0]!, /documents\/.+\/s2-aufgabe-3\.md/, "the search result, with its file, reached the model");
		const results = agent.state.messages.filter((m) => m.role === "toolResult") as unknown as { toolName: string; details: { kind: string } }[];
		assert.deepEqual(results.map((r) => [r.toolName, r.details.kind]), [["search_documents", "search"]]);
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
	const docs = { search: async () => ({ mode: "keyword" as const, query: "", hits: [] }) };

	it("defaults on, and the setting turns it off", () => {
		assert.equal(documentToolsEnabled(resolveSettings(null)), true);
		assert.equal(documentToolsEnabled(resolveSettings({ version: 1, agent: { documentTools: { enabled: false } } })), false);
		assert.deepEqual(sanitizeUserSettings({ version: 1, agent: { documentTools: { enabled: false } } })?.agent?.documentTools, { enabled: false });
		assert.equal(parseAgentSettingsBody({ documentTools: { enabled: "no" } }).ok, false);
	});

	it("prober, teacher and practice carry the search tool only when the context passes them", () => {
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
