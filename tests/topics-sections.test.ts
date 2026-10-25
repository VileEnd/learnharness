/**
 * PR H, core + pipeline: section-aware extraction of a stored document
 * (what the extractor sees, the submit schema's error-back, the section /
 * page provenance and the topic rows the merger writes through the alias
 * table), the topics ledger's consumers (snapshot grouping, node deletion)
 * and the groupBy render setting. Faux engines, in-memory ledgers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { parseSections } from "../src/core/documents.ts";
import { graphSnapshot, mergeTopicRows } from "../src/core/graph.ts";
import { deleteChatTraces, deleteNodeTraces } from "../src/core/graph-deletion.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings } from "../src/core/render-settings.ts";
import { addAliases, canonicalTopic } from "../src/core/topics.ts";
import type { DocumentMeta } from "../src/core/contracts/documents.ts";
import type { GraphNode } from "../src/core/contracts.ts";
import { memoryGraphStore, noChats } from "./memory-graph-store.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const submit = (name: string, input: unknown): ReturnType<typeof fauxAssistantMessage> =>
	fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], { stopReason: "toolUse" });

const lastUserText = (context: unknown): string => {
	const messages = (context as { messages?: { role: string; content: unknown }[] }).messages ?? [];
	const last = [...messages].reverse().find((m) => m.role === "user");
	return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
};

const DOC = [
	"<!-- page 1 -->",
	"# Skript",
	"![page 1](page-1.png)",
	"Intro alpha.",
	"<!-- page 3 -->",
	"## 2 Kontextwechsel",
	"Switching beta.",
	"<!-- page 4 -->",
	"### 2.1 Register",
	"Registers gamma.",
].join("\n");

const prop = (over: Record<string, unknown> = {}) => ({
	id: "p1",
	name: "Semaphore",
	statement: "A semaphore counts permits that gate access to a shared resource.",
	aliases: [],
	topics: ["Semaphor"],
	section: "s3",
	...over,
});

function setup(extractorSteps: FauxResponseStep[]) {
	const ledgers = memoryGraphStore();
	const pipeline = createExtractionPipeline({
		chatStore: noChats,
		graphStore: ledgers,
		extractor: fauxEngine(extractorSteps),
		auditor: fauxEngine([() => submit("submit_review", { links: [] })]),
	});
	const input = {
		id: "doc_aaaaaaaaaaaa",
		filePath: "secret-name.md",
		title: "Skript BS",
		text: DOC,
		topics: ["Semaphoren", "Kontextwechsel"],
		sections: parseSections(DOC),
	};
	return { ledgers, pipeline, input };
}

describe("document extraction", () => {
	it("shows title, location and topics (never the filename); the merger stamps section, pages and canonical topics", async () => {
		let view = "";
		const { ledgers, pipeline, input } = setup([
			(context) => {
				view = lastUserText(context);
				return submit("submit_findings", { propositions: [prop()], chains: [] });
			},
		]);
		ledgers.writeTopicAliases(addAliases({}, { Semaphor: "Semaphoren" }));
		const stats = await pipeline.importNotes(input);
		assert.deepEqual(stats, { nodes: 1, chains: 0 });

		assert.match(view, /^DOCUMENT: Skript BS — § Skript … Skript › 2 Kontextwechsel › 2\.1 Register \(pp\. 1–4\)/);
		assert.ok(view.includes("THE DOCUMENT'S TOPICS: Semaphoren; Kontextwechsel"));
		assert.ok(view.includes("s3 = Skript › 2 Kontextwechsel › 2.1 Register (p. 4)"));
		assert.ok(!view.includes("secret-name"), "the filename never reaches the extractor");
		assert.ok(!/<!--\s*page|!\[page/.test(view), "page markers and page images are stripped");

		const [node] = ledgers.readNodes();
		assert.deepEqual(node!.provenance, [{ chatId: input.id, messageId: "", section: "s3", pageFrom: 4, pageTo: 4 }]);
		const rows = ledgers.readTopics();
		assert.deepEqual(rows.map((r) => [r.nodeId, r.topic, r.sourceId]), [[node!.id, "Semaphoren", input.id]], "Semaphor maps through the alias table");
		assert.equal(ledgers.readSources()[0]!.filePath, "Skript BS", "the source is labelled by the title");
	});

	for (const [what, bad, message] of [
		["an unknown section", prop({ section: "s9" }), /which is not in THIS stretch/],
		["a missing section", prop({ section: "" }), /missing its section/],
		["no topics when the document has some", prop({ topics: [] }), /has no topics/],
		["too many topics", prop({ topics: ["a", "b", "c", "d"] }), /at most 3/],
	] as const) {
		it(`${what} is sent back to the extractor, and nothing merges until a valid submit`, async () => {
			let secondCall = "";
			const { ledgers, pipeline, input } = setup([
				() => submit("submit_findings", { propositions: [bad], chains: [] }),
				(context) => {
					secondCall = JSON.stringify((context as { messages: unknown }).messages);
					return submit("submit_findings", { propositions: [prop()], chains: [] });
				},
			]);
			assert.deepEqual(await pipeline.importNotes(input), { nodes: 1, chains: 0 });
			assert.match(secondCall, message, "the refusal rode the error-back channel");
			assert.equal(ledgers.readNodes().length, 1);
		});
	}

	it("an input without sections keeps the plain notes door: no topics, no section, bare provenance", async () => {
		const { ledgers, pipeline } = setup([
			() => submit("submit_findings", { propositions: [{ id: "p1", name: "Idea", statement: "An idea.", aliases: [] }], chains: [] }),
		]);
		await pipeline.importNotes({ filePath: "plain.md", text: "just some notes" });
		assert.deepEqual(ledgers.readNodes()[0]!.provenance.map((p) => Object.keys(p).sort()), [["chatId", "messageId"]]);
		assert.deepEqual(ledgers.readTopics(), []);
	});
});

describe("topic rows", () => {
	const node = (id: string, chatId: string, extra: Partial<GraphNode> = {}): GraphNode => ({
		id,
		name: id,
		statement: `${id} statement`,
		aliases: [],
		createdAt: "2026-10-01T00:00:00.000Z",
		provenance: [{ chatId, messageId: "" }],
		...extra,
	});

	it("mergeTopicRows maps through the aliases, dedupes, and skips unknown nodes", () => {
		const ledgers = memoryGraphStore();
		ledgers.appendNode(node("n1", "src_a"));
		ledgers.writeTopicAliases(addAliases({}, { semaphores: "Semaphoren" }));
		const deps = { chatStore: noChats, graphStore: ledgers };
		const rows = [
			{ nodeId: "n1", topics: ["Semaphores", "semaphoren", "Mutex"] },
			{ nodeId: "ghost", topics: ["Mutex"] },
		];
		assert.equal(mergeTopicRows("src_a", rows, deps, "2026-10-02T00:00:00.000Z"), 2);
		assert.equal(mergeTopicRows("src_a", rows, deps), 0, "idempotent");
		assert.deepEqual(ledgers.readTopics().map((r) => r.topic), ["Semaphoren", "Mutex"]);
		assert.equal(canonicalTopic("  SEMAPHORES ", ledgers.readTopicAliases()), "Semaphoren");
	});

	/** Docs A and B (3 nodes each, topic "Semaphoren" on all six) and C (3 untagged). */
	function groupedGraph() {
		const ledgers = memoryGraphStore();
		const metas = [
			["src_a", "Sheet 8"],
			["src_b", "Sheet 9"],
			["src_c", "Sheet 10"],
		] as const;
		for (const [src, title] of metas) {
			ledgers.upsertSource({ id: src, filePath: title, importedAt: "2026-10-01T00:00:00.000Z" });
			for (let i = 1; i <= 3; i++) ledgers.appendNode(node(`${src}_${i}`, src));
		}
		const deps = { chatStore: noChats, graphStore: ledgers };
		for (const src of ["src_a", "src_b"]) {
			mergeTopicRows(src, [1, 2, 3].map((i) => ({ nodeId: `${src}_${i}`, topics: ["Semaphoren", "Mutex"] })), deps);
		}
		return { ledgers, deps };
	}

	it("topic mode clusters by a node's FIRST topic, falls back to its source, and layout stays source-based", () => {
		const { deps } = groupedGraph();
		const bySource = graphSnapshot(deps);
		assert.equal(bySource.groupBy, "source");
		assert.deepEqual(bySource.clusters.map((c) => c.label).sort(), ["Sheet 10", "Sheet 8", "Sheet 9"]);
		assert.equal(bySource.layoutClusters, undefined);

		const byTopic = graphSnapshot(deps, { groupBy: "topic" });
		assert.equal(byTopic.groupBy, "topic");
		const topic = byTopic.clusters.find((c) => c.label === "Semaphoren")!;
		assert.equal(topic.members.length, 6, "one topic spans both sheets");
		assert.ok(!byTopic.clusters.some((c) => c.label === "Mutex"), "a node joins only its first topic");
		const fallback = byTopic.clusters.find((c) => c.label === "Sheet 10")!;
		assert.equal(fallback.members.length, 3, "untagged nodes keep their source cluster");
		assert.deepEqual(byTopic.layoutClusters!.map((c) => c.id).sort(), bySource.clusters.map((c) => c.id).sort());
		assert.deepEqual(byTopic.nodeTopics["src_a_1"], ["Semaphoren", "Mutex"]);
	});

	it("source mode labels a stored document's cluster with its TITLE and the snapshot names the section", () => {
		const { ledgers, deps } = groupedGraph();
		ledgers.appendNode(node("n_sec", "src_a", { provenance: [{ chatId: "src_a", messageId: "", section: "s2", pageFrom: 3, pageTo: 4 }] }));
		const meta = {
			id: "doc_1",
			sourceId: "src_a",
			title: "Betriebssysteme Blatt 8",
			sections: [{ id: "s2", headingPath: ["Skript", "2 Kontextwechsel"], pageFrom: 3, pageTo: 4, start: 0, end: 1 }],
		} as unknown as DocumentMeta;
		const snap = graphSnapshot(deps, { documents: { listMetas: () => [meta] } });
		assert.ok(snap.clusters.some((c) => c.label === "Betriebssysteme Blatt 8"), "title, not the filename-ish source record");
		assert.deepEqual(snap.documents["src_a"], {
			id: "doc_1",
			title: "Betriebssysteme Blatt 8",
			sections: { s2: { headingPath: ["Skript", "2 Kontextwechsel"], pageFrom: 3, pageTo: 4 } },
		});
	});

	it("deleting a node drops its topic rows; deleting a chat drops only the dead nodes' rows", () => {
		const { ledgers } = groupedGraph();
		assert.equal(ledgers.readTopics().length, 12);
		deleteNodeTraces(ledgers, "src_a_1");
		assert.equal(ledgers.readTopics().filter((r) => r.nodeId === "src_a_1").length, 0);
		assert.equal(ledgers.readTopics().length, 10);

		// A chat contributed to src_b_1 as well: that node survives its deletion.
		const shared = ledgers.readNodes().find((n) => n.id === "src_b_1")!;
		ledgers.rewriteLedgers({
			nodes: ledgers.readNodes().map((n) => (n.id === "src_b_1" ? { ...shared, provenance: [...shared.provenance, { chatId: "chat_x", messageId: "m" }] } : n)),
		});
		ledgers.appendNode(node("chat_only", "chat_x"));
		mergeTopicRows("chat_x", [{ nodeId: "chat_only", topics: ["Mutex"] }], { chatStore: noChats, graphStore: ledgers });
		deleteChatTraces(ledgers, "chat_x", "delete-nodes");
		const left = new Set(ledgers.readTopics().map((r) => r.nodeId));
		assert.ok(!left.has("chat_only"), "the dead node's row is gone");
		assert.ok(left.has("src_b_1"), "a surviving shared node keeps its rows");
	});
});

describe("groupBy render setting", () => {
	it("defaults to source, survives a JSON round trip, and garbage falls back", () => {
		assert.equal(DEFAULT_RENDER_SETTINGS.groupBy, "source");
		const saved = sanitizeRenderSettings({ ...DEFAULT_RENDER_SETTINGS, groupBy: "topic" });
		assert.equal(sanitizeRenderSettings(JSON.parse(JSON.stringify(saved))).groupBy, "topic");
		assert.equal(sanitizeRenderSettings({ groupBy: "sideways" }).groupBy, "source");
		assert.equal(sanitizeRenderSettings({}).groupBy, "source", "files from before the setting load as source");
	});
});
