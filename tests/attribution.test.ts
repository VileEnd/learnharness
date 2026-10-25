/**
 * The attribution stage: graded, untagged questions of a session are linked
 * to the session's concepts by the cheap-slot agent; the ledger gets one row
 * per item (an explicit empty one included); a failure appends nothing.
 * Faux engines only; the debounce trigger itself is never armed in tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createAttributor } from "../src/agent/subagents/attribution.ts";
import { createAttributionService } from "../src/server/attribution.ts";
import type { AttributionRow, GraphNode } from "../src/core/contracts.ts";
import { chat, quiz } from "./learner-helpers.ts";

const call = (name: string, input: unknown) =>
	fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], { stopReason: "toolUse" });

function attributorWith(steps: FauxResponseStep[]) {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return createAttributor({ engineFor: () => engine });
}

const node = (id: string, chatId: string): GraphNode => ({
	id,
	name: `Name ${id}`,
	statement: `Statement ${id}`,
	aliases: [],
	createdAt: "2026-10-20T09:00:00.000Z",
	provenance: [{ chatId, messageId: "m" }],
});

function setup(steps: FauxResponseStep[], opts: { nodes?: GraphNode[] } = {}) {
	const record = chat("c1", [...quiz("q1", { pick: 1 }), ...quiz("q2", { pick: 2 }), ...quiz("q3", { pick: 1, concepts: ["n1"] })]);
	const rows: AttributionRow[] = [];
	const nodes = opts.nodes ?? [node("n1", "c1"), node("n2", "c1"), node("n3", "c1"), node("n9", "other")];
	const service = createAttributionService({
		chatStore: { getChat: (id) => (id === "c1" ? record : null) },
		graphStore: { readNodes: () => nodes, readChains: () => [] },
		learnerStore: { appendAttribution: (r) => void rows.push(r), readAttributions: () => [...rows] },
		attributor: attributorWith(steps),
		now: () => new Date("2026-10-22T08:00:00.000Z"),
	});
	return { service, rows };
}

describe("attribution", () => {
	it("fills untagged items and stores empty results; a rerun sends no items", async () => {
		let prompt = "";
		const { service, rows } = setup([
			(context) => {
				prompt = JSON.stringify((context as { messages: unknown }).messages);
				return call("attribute_items", {
					links: [
						{ toolCallId: "q1", conceptIds: ["n3"] },
						{ toolCallId: "q2", conceptIds: [] },
					],
				});
			},
		]);
		assert.equal(await service.attributeChat("c1"), 2);
		assert.deepEqual(
			rows.map((r) => [r.chatId, r.toolCallId, r.conceptIds, r.at]),
			[
				["c1", "q1", ["n3"], "2026-10-22T08:00:00.000Z"],
				["c1", "q2", [], "2026-10-22T08:00:00.000Z"],
			],
		);
		// Only this chat's concepts and only the untagged items were offered.
		assert.match(prompt, /n1 \| Name n1/);
		assert.doesNotMatch(prompt, /n9/);
		assert.doesNotMatch(prompt, /q3/);
		// Rerun: nothing left, no model call (the faux queue is empty and would fail).
		assert.equal(await service.attributeChat("c1"), 0);
		assert.equal(rows.length, 2);
		assert.equal(service.hasPendingItems("c1"), false);
	});

	it("refuses invented concept ids and missing items back to the model, then accepts a valid answer", async () => {
		let second = "";
		let third = "";
		const { service, rows } = setup([
			() => call("attribute_items", { links: [{ toolCallId: "q1", conceptIds: ["n_made_up"] }, { toolCallId: "q2", conceptIds: [] }] }),
			(context) => {
				second = JSON.stringify((context as { messages: unknown }).messages);
				return call("attribute_items", { links: [{ toolCallId: "q1", conceptIds: ["n1"] }] });
			},
			(context) => {
				third = JSON.stringify((context as { messages: unknown }).messages);
				return call("attribute_items", { links: [{ toolCallId: "q1", conceptIds: ["n1"] }, { toolCallId: "q2", conceptIds: [] }] });
			},
		]);
		assert.equal(await service.attributeChat("c1"), 2);
		assert.match(second, /is not in the CONCEPTS list/);
		assert.match(third, /no entry for item/);
		assert.deepEqual(rows.map((r) => r.conceptIds), [["n1"], []]);
	});

	it("attribution failure appends nothing and does not throw", async () => {
		const faux = createFauxCore({});
		faux.setResponses([
			() => {
				throw new Error("model down");
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const rows: AttributionRow[] = [];
		const record = chat("c1", quiz("q1", { pick: 1 }));
		const service = createAttributionService({
			chatStore: { getChat: () => record },
			graphStore: { readNodes: () => [node("n1", "c1")], readChains: () => [] },
			learnerStore: { appendAttribution: (r) => void rows.push(r), readAttributions: () => [...rows] },
			attributor: createAttributor({ engineFor: () => engine }),
		});
		const quiet = console.error;
		console.error = () => {};
		try {
			assert.equal(await service.attributeChat("c1"), 0);
		} finally {
			console.error = quiet;
		}
		assert.deepEqual(rows, []);
		assert.equal(service.hasPendingItems("c1"), true, "the item stays pending for the next trigger");
	});

	it("a chat without propositions of its own appends nothing and calls no model", async () => {
		const { service, rows } = setup([], { nodes: [node("n9", "other")] });
		assert.equal(await service.attributeChat("c1"), 0);
		assert.deepEqual(rows, []);
	});

	it("an unconfigured cheap slot skips quietly", async () => {
		const rows: AttributionRow[] = [];
		const record = chat("c1", quiz("q1", { pick: 1 }));
		const service = createAttributionService({
			chatStore: { getChat: () => record },
			graphStore: { readNodes: () => [node("n1", "c1")], readChains: () => [] },
			learnerStore: { appendAttribution: (r) => void rows.push(r), readAttributions: () => [...rows] },
			attributor: createAttributor({ engineFor: () => undefined }),
		});
		const quiet = console.info;
		console.info = () => {};
		try {
			assert.equal(await service.attributeChat("c1"), 0);
		} finally {
			console.info = quiet;
		}
		assert.deepEqual(rows, []);
	});

	it("runs are serial per chat", async () => {
		const { service, rows } = setup([() => call("attribute_items", { links: [{ toolCallId: "q1", conceptIds: ["n1"] }, { toolCallId: "q2", conceptIds: [] }] })]);
		const [a, b] = await Promise.all([service.attributeChat("c1"), service.attributeChat("c1")]);
		assert.deepEqual([a, b], [2, 0], "the second run sees the first run's rows");
		assert.equal(rows.length, 2);
	});
});
