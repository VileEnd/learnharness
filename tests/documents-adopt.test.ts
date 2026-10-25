/**
 * PR H, adopting old imports: a re-uploaded original whose FILE NAME maps to
 * a legacy graph source ("src_" + sha256(filename)) with nodes and no
 * document is "legacy" and is attached without re-extraction (the document
 * is stored against the old source; a cheap tagging pass files its nodes
 * under the document's topics, through the merger). A legacy source with no
 * nodes (the old raw-PDF text imports) is only a hint - the file is new.
 * Also: a new document's topics are canonicalised onto the library's
 * before extraction, and extraction gets sections + topics.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-adopt-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.OCR_URL;

const { createDocumentService } = await import("../src/server/documents.ts");
const { documentStore } = await import("../src/store/documents.ts");
const { createOcrClient } = await import("../src/server/ocr-client.ts");
const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const { legacySourceIds } = await import("../src/core/documents.ts");
const { memoryGraphStore, noChats } = await import("./memory-graph-store.ts");
import type { NotesImportInput } from "../src/agent/subagents/extraction.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(TMP_DATA, "documents"), { recursive: true, force: true }));

const bytes = (s: string) => new TextEncoder().encode(s);
const prose = (n: number, salt = "") => Array.from({ length: n }, (_, i) => `term${i}${salt}`).join(" ");
const md = (name: string, text: string) => ({ name, bytes: bytes(text) });

const LEGACY_NAME = "learn database.md";
const LEGACY_ID = legacySourceIds(LEGACY_NAME)[0]!;

function harness(opts: { legacyNodes?: number; topics?: string[]; canonicalize?: (n: readonly string[], e: readonly string[]) => Record<string, string> } = {}) {
	const graph = memoryGraphStore();
	graph.upsertSource({ id: LEGACY_ID, filePath: LEGACY_NAME, importedAt: "2026-09-30T14:48:11.111Z" });
	for (let i = 0; i < (opts.legacyNodes ?? 3); i++) {
		graph.appendNode({
			id: `n_${i}`,
			name: `Idea ${i}`,
			statement: `Statement ${i}.`,
			aliases: [],
			createdAt: "2026-09-30T14:48:12.000Z",
			provenance: [{ chatId: LEGACY_ID, messageId: "" }],
		});
	}
	const extracted: NotesImportInput[] = [];
	const aliasesAtExtraction: Record<string, string>[] = [];
	const tagged: { topics: readonly string[]; ids: string[] }[] = [];
	const pipeline = createExtractionPipeline({ chatStore: noChats, graphStore: graph });
	const unconfigured = createOcrClient({ baseUrl: () => undefined });
	const service = createDocumentService({
		store: documentStore,
		importNotes: async (input) => {
			extracted.push(input);
			aliasesAtExtraction.push(graph.readTopicAliases());
			return { nodes: 1, chains: 0 };
		},
		describe: async () => ({ title: "Datenbanken", summary: "s", topics: opts.topics ?? ["Datenbanken", "SQL"] }),
		ocr: unconfigured,
		graph,
		canonicalize: async (n, e) => (opts.canonicalize ? opts.canonicalize(n, e) : Object.fromEntries(n.map((t) => [t, t]))),
		tagNodes: async (topics, nodes) => {
			tagged.push({ topics, ids: nodes.map((n) => n.id) });
			return nodes.map((n) => ({ nodeId: n.id, topics: [topics[0]!] }));
		},
		// The REAL pipeline's merger entry point: rows reach the ledger only through it.
		applyTopicRows: (input) => pipeline.applyTopicRows(input),
		notify: () => {},
		pollMs: 0,
	});
	return { service, graph, extracted, aliasesAtExtraction, tagged };
}

describe("legacy detection", () => {
	it("the legacy id is src_ + sha256(filename)[0:12] (the old importer's identity)", () => {
		assert.equal(LEGACY_ID, "src_d29e7ef2599a", "the golden fixture's 'learn database.md' source");
	});

	it("a file whose name maps to a legacy source with nodes is 'legacy', with date and node count", async () => {
		const { service } = harness();
		const [legacy, other] = await service.check([md(LEGACY_NAME, `# DB\n\n${prose(60)}`), md("other name.md", `# X\n\n${prose(60, "x")}`)]);
		assert.equal(legacy!.verdict.status, "legacy");
		assert.deepEqual(legacy!.verdict.legacy, { sourceId: LEGACY_ID, importedAt: "2026-09-30T14:48:11.111Z", nodeCount: 3 });
		assert.equal(other!.verdict.status, "new");
	});

	it("a legacy source that produced no nodes is NOT legacy: offered as new, with a hint", async () => {
		const { service } = harness({ legacyNodes: 0 });
		const [result] = await service.check([md(LEGACY_NAME, `# DB\n\n${prose(60)}`)]);
		assert.equal(result!.verdict.status, "new");
		assert.deepEqual(result!.legacyEmpty, { sourceId: LEGACY_ID, importedAt: "2026-09-30T14:48:11.111Z" });
	});
});

describe("attach", () => {
	it("is the default: no extraction, the document is stored against the old source, nodes get topic rows via the merger", async () => {
		const { service, graph, extracted, tagged } = harness();
		const [ticket] = await service.importFiles([md(LEGACY_NAME, `# DB\n\n${prose(60)}`)]); // no decision given
		assert.equal(ticket!.outcome, "started");
		const done = await ticket!.completion!;
		assert.deepEqual([done.ok, done.attached, done.tagged], [true, true, 3]);
		assert.equal(extracted.length, 0, "no extraction call");

		const meta = documentStore.getMeta(ticket!.docId!)!;
		assert.match(meta.id, /^doc_[0-9a-f]{12}$/);
		assert.equal(meta.sourceId, LEGACY_ID, "the document feeds the legacy graph source");
		assert.equal(graph.readSources().find((s) => s.id === LEGACY_ID)!.filePath, "Datenbanken", "the old source is labelled by the title");
		assert.equal(graph.readSources().find((s) => s.id === LEGACY_ID)!.importedAt, "2026-09-30T14:48:11.111Z", "and keeps its record");
		assert.deepEqual(tagged[0], { topics: ["Datenbanken", "SQL"], ids: ["n_0", "n_1", "n_2"] });
		assert.deepEqual(graph.readTopics().map((r) => [r.nodeId, r.topic, r.sourceId]), [0, 1, 2].map((i) => [`n_${i}`, "Datenbanken", LEGACY_ID]));
		assert.equal(graph.readNodes().length, 3, "no node was added or removed");

		// Attached once: the same name is no longer 'legacy' for different content.
		const [again] = await service.check([md(LEGACY_NAME, `# DB v2\n\n${prose(60, "v2")}`)]);
		assert.equal(again!.verdict.status, "new");
	});

	it("'new' on a legacy file re-extracts it as a fresh document instead", async () => {
		const { service, extracted, graph } = harness();
		const [ticket] = await service.importFiles([md(LEGACY_NAME, `# DB\n\n${prose(60)}`)], ["new"]);
		const done = await ticket!.completion!;
		assert.equal(done.attached, undefined);
		assert.equal(extracted.length, 1);
		assert.equal(extracted[0]!.id, ticket!.docId, "its own source, not the legacy one");
		assert.equal(graph.readTopics().length, 0);
	});

	it("'skip' leaves everything alone", async () => {
		const { service, extracted } = harness();
		const [ticket] = await service.importFiles([md(LEGACY_NAME, `# DB\n\n${prose(60)}`)], ["skip"]);
		assert.equal(ticket!.outcome, "skipped");
		assert.equal(extracted.length, 0);
		assert.equal(documentStore.listMetas().length, 0);
	});
});

describe("a new document", () => {
	it("hands extraction its sections and topics, with topics canonicalised and the alias table written BEFORE extraction", async () => {
		// A first document establishes the library topic "Semaphoren".
		const first = harness({ legacyNodes: 0 });
		const [a] = await first.service.importFiles([md("a.md", `---\ntitle: "A"\nsummary: ""\ntopics: ["Semaphoren"]\n---\n# A\n\n${prose(60, "a")}`)]);
		await a!.completion;

		// A second one arrives with the variant spelling; the library's canonicaliser folds it.
		const second = harness({
			legacyNodes: 0,
			canonicalize: (n, e) => Object.fromEntries(n.map((t) => [t, e.find((x) => x.toLowerCase().startsWith(t.toLowerCase())) ?? t])),
		});
		const text = `---\ntitle: "B"\nsummary: ""\ntopics: ["Semaphor"]\n---\n# B\n\n## 1 Intro\n\n${prose(60, "b")}`;
		const [b] = await second.service.importFiles([md("b.md", text)]);
		await b!.completion;

		const input = second.extracted[0]!;
		assert.deepEqual(input.topics, ["Semaphoren"], "the variant maps onto the existing topic");
		assert.deepEqual(second.aliasesAtExtraction[0], { semaphor: "Semaphoren" }, "the alias table exists when extraction starts");
		assert.deepEqual(documentStore.getMeta(b!.docId!)!.topics, ["Semaphoren"]);
		assert.ok(input.sections && input.sections.length >= 2);
		// Section offsets index INTO the text the extractor receives (front matter removed).
		for (const s of input.sections!) assert.ok(input.text.slice(s.start, s.end).trim() !== "" && s.end <= input.text.length);
		assert.ok(input.text.slice(input.sections![0]!.start).startsWith("# B"));
	});

	it("a failing canonicaliser never blocks the import", async () => {
		const { service, extracted } = harness({
			legacyNodes: 0,
			canonicalize: () => {
				throw new Error("no model");
			},
		});
		const [t] = await service.importFiles([md("c.md", `# C\n\n${prose(60, "c")}`)]);
		const done = await t!.completion!;
		assert.equal(done.ok, true);
		assert.deepEqual(extracted[0]!.topics, ["Datenbanken", "SQL"]);
	});
});
