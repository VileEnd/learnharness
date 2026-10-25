/**
 * PR H, the cheap-slot topic agents and the small pure helpers around
 * them: canonicalize (new topics onto existing ones, vocabulary-checked),
 * tagNodes (batched, vocabulary-checked), the alias table, and the detail
 * card's document citation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createTopicist, TAG_BATCH_NODES } from "../src/agent/subagents/topics.ts";
import { documentCitation } from "../src/core/chains.ts";
import { addAliases, canonicalTopics } from "../src/core/topics.ts";

const engine = (steps: FauxResponseStep[]): PiEngine => {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
};
const call = (name: string, input: unknown) =>
	fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], { stopReason: "toolUse" });
const topicist = (steps: FauxResponseStep[]) => {
	const e = engine(steps);
	return createTopicist({ engineFor: () => e });
};

describe("canonicalize", () => {
	it("maps variants onto existing topics, across languages; unlisted topics map to themselves", async () => {
		const t = topicist([
			() =>
				call("canonicalize_topics", {
					mapping: [
						{ topic: "Semaphor", canonical: "Semaphoren" },
						{ topic: "semaphores", canonical: "Semaphoren" },
					],
				}),
		]);
		const out = await t.canonicalize(["Semaphor", "semaphores", "Deadlock"], ["Semaphoren", "Mutex"]);
		assert.deepEqual(out, { Semaphor: "Semaphoren", semaphores: "Semaphoren", Deadlock: "Deadlock" });
	});

	it("refuses an invented canonical topic (error-back), then accepts a valid mapping", async () => {
		let second = "";
		const t = topicist([
			() => call("canonicalize_topics", { mapping: [{ topic: "Semaphor", canonical: "Made up" }] }),
			(context) => {
				second = JSON.stringify((context as { messages: unknown }).messages);
				return call("canonicalize_topics", { mapping: [{ topic: "Semaphor", canonical: "Semaphoren" }] });
			},
		]);
		assert.deepEqual(await t.canonicalize(["Semaphor"], ["Semaphoren"]), { Semaphor: "Semaphoren" });
		assert.match(second, /neither an existing topic nor one of the new topics/);
	});

	it("makes no model call when there is nothing to fold", async () => {
		const t = createTopicist({ engineFor: () => { throw new Error("must not be called"); } });
		assert.deepEqual(await t.canonicalize(["Only one"], []), { "Only one": "Only one" });
		assert.deepEqual(await t.canonicalize([], ["x"]), {});
	});
});

describe("tagNodes", () => {
	const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n_${i}`, name: `Idea ${i}`, statement: `Statement ${i}` }));

	it("assigns topics from the offered list, batched", async () => {
		let calls = 0;
		const t = topicist([
			(context) => {
				calls++;
				const prompt = JSON.stringify((context as { messages: unknown }).messages);
				const ids = [...prompt.matchAll(/n_\d+/g)].map((m) => m[0]);
				return call("tag_nodes", { assignments: [...new Set(ids)].map((id) => ({ id, topics: ["sql"] })) });
			},
			(context) => {
				calls++;
				const prompt = JSON.stringify((context as { messages: unknown }).messages);
				const ids = [...prompt.matchAll(/n_\d+/g)].map((m) => m[0]);
				return call("tag_nodes", { assignments: [...new Set(ids)].map((id) => ({ id, topics: ["SQL", "Datenbanken"] })) });
			},
		]);
		const out = await t.tagNodes(["Datenbanken", "SQL"], nodes(TAG_BATCH_NODES + 5));
		assert.equal(calls, 2, "one call per batch");
		assert.equal(out.length, TAG_BATCH_NODES + 5);
		assert.deepEqual(out[0]!.topics, ["SQL"], "model casing is replaced by the offered label");
		assert.deepEqual(out[TAG_BATCH_NODES]!.topics, ["SQL", "Datenbanken"]);
	});

	it("refuses a topic outside the list (error-back)", async () => {
		let second = "";
		const t = topicist([
			() => call("tag_nodes", { assignments: [{ id: "n_0", topics: ["Astrology"] }] }),
			(context) => {
				second = JSON.stringify((context as { messages: unknown }).messages);
				return call("tag_nodes", { assignments: [{ id: "n_0", topics: ["SQL"] }] });
			},
		]);
		assert.deepEqual(await t.tagNodes(["SQL"], nodes(1)), [{ nodeId: "n_0", topics: ["SQL"] }]);
		assert.match(second, /not in the TOPICS list/);
	});
});

describe("alias table and citation", () => {
	it("addAliases stays one hop deep and ignores identities", () => {
		const table = addAliases({}, { Semaphor: "Semaphoren", Semaphoren: "Semaphoren" });
		assert.deepEqual(table, { semaphor: "Semaphoren" });
		assert.deepEqual(addAliases(table, { semaphores: "Semaphor" }), { semaphor: "Semaphoren", semaphores: "Semaphoren" }, "an alias of an alias lands on the canonical");
		assert.deepEqual(canonicalTopics(["SEMAPHOR", "semaphoren", "Mutex"], table), ["Semaphoren", "Mutex"]);
	});

	it("documentCitation: title, section heading, page; absent parts simply drop", () => {
		const doc = { id: "doc_1", title: "Blatt 8", sections: { s2: { headingPath: ["Skript", "2.1 Register"], pageFrom: 3 } } };
		assert.deepEqual(documentCitation(doc, { section: "s2", pageFrom: 4 }), { label: "Blatt 8 · §2.1 Register · p.4", page: 4 });
		assert.deepEqual(documentCitation(doc, { section: "s2" }), { label: "Blatt 8 · §2.1 Register · p.3", page: 3 });
		assert.deepEqual(documentCitation(doc, {}), { label: "Blatt 8" }, "an adopted old import has neither");
	});
});
