/**
 * PR 4, the one-off topic backfill: every node without a topic row is tagged
 * once (open-ended cheap-slot tagging, canonicalised, merged through the
 * pipeline's applyTopicRows), a second call tags nothing, errors are
 * contained, and the run shows as an activity row. Faux providers only; an
 * isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-topic-backfill-"));
process.env.LH_DATA_DIR = TMP;

const { graphStore } = await import("../src/store/graph.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createTopicist } = await import("../src/agent/subagents/topics.ts");
const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const { createTopicBackfill, BACKFILL_CHUNK_NODES } = await import("../src/server/topic-backfill.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const node = (id: string, chat: string) => ({
	id,
	name: `Idea ${id}`,
	statement: `Statement of ${id}.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId: chat, messageId: "m1" }],
});

const engine = (steps: FauxResponseStep[]): PiEngine => {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
};
const tagStep = (assignments: { id: string; topics: string[] }[]): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall("tag_nodes", { assignments } as unknown as ToolCall["arguments"], { id: "tag-call" })], {
		stopReason: "toolUse",
	});

const pipeline = createExtractionPipeline({ chatStore, graphStore });
const make = (steps: FauxResponseStep[], extra: Partial<Parameters<typeof createTopicBackfill>[0]> = {}) => {
	const e = engine(steps);
	const topicist = createTopicist({ engineFor: () => e });
	return createTopicBackfill({
		graph: graphStore,
		tagOpen: (nodes, existing, signal) => topicist.tagOpen(nodes, existing, signal),
		applyTopicRows: (input) => pipeline.applyTopicRows(input),
		...extra,
	});
};

describe("topic backfill", () => {
	it("backfill tags untagged nodes once: the first POST tags them, the second tags 0", async () => {
		graphStore.appendNode(node("n1", "chat_a"));
		graphStore.appendNode(node("n2", "chat_b"));
		graphStore.appendNode(node("n3", "chat_a"));
		// n3 already has a topic row: the backfill never touches it
		graphStore.appendTopic({ nodeId: "n3", topic: "Mutex", sourceId: "chat_a", at: "2026-10-01T00:00:00.000Z" });

		const titles: string[] = [];
		let rowRuns = 0;
		const backfill = make(
			[tagStep([{ id: "n1", topics: ["Semaphore", "Nebenläufigkeit"] }, { id: "n2", topics: ["Lineare Algebra"] }])],
			{
				// the faux canonicalizer folds the variant spelling
				canonicalize: async (topics) => Object.fromEntries(topics.map((t) => [t, t === "Semaphore" ? "Semaphoren" : t])),
				activityRow: async (title, run) => {
					rowRuns += 1;
					titles.push(title);
					return run((t) => titles.push(t), new AbortController().signal);
				},
			},
		);

		const first = backfill.start();
		assert.equal(first.pending, 2, "n3 is already tagged");
		const done = await first.completion!;
		assert.deepEqual(done, { pending: 2, tagged: 2, rows: 3 });
		assert.equal(rowRuns, 1, "shown as one activity row");
		assert.match(titles[0]!, /Tagging topics/);

		const rows = graphStore.readTopics().filter((r) => r.nodeId !== "n3");
		assert.deepEqual(
			rows.map((r) => [r.nodeId, r.topic, r.sourceId]).sort(),
			[
				["n1", "Nebenläufigkeit", "chat_a"],
				["n1", "Semaphoren", "chat_a"],
				["n2", "Lineare Algebra", "chat_b"],
			],
			"canonical topics, sourceId = the node's own session",
		);
		assert.deepEqual(graphStore.readTopicAliases(), { semaphore: "Semaphoren" });

		const second = backfill.start();
		assert.equal(second.pending, 0, "a second call tags 0");
		assert.equal(second.completion, undefined);
	});

	it("errors are contained: the pass stops, merged rows stay, the next call resumes", async () => {
		const count = BACKFILL_CHUNK_NODES + 1; // two chunks
		for (let i = 0; i < count; i++) graphStore.appendNode(node(`m${i}`, "chat_m"));
		const firstChunk = Array.from({ length: BACKFILL_CHUNK_NODES }, (_, i) => ({ id: `m${i}`, topics: ["Bulk"] }));
		const failing = make([tagStep(firstChunk), () => fauxAssistantMessage("no tool call"), () => fauxAssistantMessage("still none"), () => fauxAssistantMessage("none")]);
		const start = failing.start();
		assert.equal(start.pending, count);
		const result = await start.completion!;
		assert.equal(result.tagged, BACKFILL_CHUNK_NODES, "the first chunk merged");
		assert.ok(result.error, "the failure is reported, not thrown");

		const resume = make([tagStep([{ id: `m${BACKFILL_CHUNK_NODES}`, topics: ["Bulk"] }])]).start();
		assert.equal(resume.pending, 1, "only the untagged remainder");
		assert.equal((await resume.completion!).tagged, 1);
	});

	it("a call during a running pass joins it instead of starting another", async () => {
		graphStore.appendNode(node("j1", "chat_j"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const backfill = make([async () => {
			await gate;
			return fauxAssistantMessage(
				[fauxToolCall("tag_nodes", { assignments: [{ id: "j1", topics: ["Join"] }] } as unknown as ToolCall["arguments"], { id: "join-call" })],
				{ stopReason: "toolUse" },
			);
		}]);
		const a = backfill.start();
		const b = backfill.start();
		assert.equal(b.running, true);
		release();
		assert.equal((await a.completion!).tagged, 1);
		assert.equal(graphStore.readTopics().filter((r) => r.nodeId === "j1").length, 1);
	});
});
