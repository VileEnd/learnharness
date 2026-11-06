import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import {
	CANDIDATE_PAGE_SIZE,
	createPropositionCandidateSearch,
	propositionCandidateBatch,
	type CandidateProposition,
} from "../src/core/proposition-candidates.ts";

function node(id: string, name: string, statement: string, aliases: string[] = []): GraphNode {
	return { id, name, statement, aliases, createdAt: "2026-01-01T00:00:00Z", provenance: [{ chatId: "source", messageId: "" }] };
}
function proposition(id: string, statement: string, name = "", topics?: string[]): CandidateProposition {
	return { id, name, statement, aliases: [], topics };
}

describe("proposition candidate retrieval", () => {
	it("ranks word overlap regardless of phrase order, with no glob syntax", () => {
		const search = createPropositionCandidateSearch([
			node("specific", "Metric", "Distances obey the triangle inequality."),
			node("generic", "Triangle", "A triangle has three corners."),
		]);
		assert.deepEqual(search(proposition("p", "inequality * triangle [metric]")).map((h) => h.node.id), ["specific", "generic"]);
	});

	it("uses the German/English tokenizer: umlauts and plurals fold", () => {
		const search = createPropositionCandidateSearch([node("de", "Mütter", "Die Mütter der Kinder")]);
		assert.equal(search(proposition("p", "Mutter"))[0]?.node.id, "de");
	});

	it("topics act as hints", () => {
		const search = createPropositionCandidateSearch([node("a", "Semaphor", "Ein Zähler für Threads"), node("b", "Other", "Something else")]);
		assert.deepEqual(search(proposition("p", "unrelated words", "", ["Semaphor"])).map((h) => h.node.id), ["a"]);
	});

	it("shows a matched alias with the canonical statement; unmatched aliases are not reported", () => {
		const search = createPropositionCandidateSearch([node("n", "Label", "The original assertion remains canonical.", ["An amber canoe travels upstream."])]);
		const batch = propositionCandidateBatch(search, [proposition("p", "amber canoe")], [{ id: "p" }]);
		assert.deepEqual(batch.candidates[0]!.matchedAliases, ["An amber canoe travels upstream."]);
		assert.equal(batch.candidates[0]!.statement, "The original assertion remains canonical.");
		const plain = propositionCandidateBatch(search, [proposition("p", "original assertion")], [{ id: "p" }]);
		assert.deepEqual(plain.candidates[0]!.matchedAliases, []);
	});

	it("pages by five, ties break by id, and repeated finding ids resolve to the first", () => {
		const nodes = Array.from({ length: 7 }, (_, i) => node(`n${i}`, "Same", "identical wording here"));
		const search = createPropositionCandidateSearch(nodes);
		const props = [proposition("p", "identical wording"), proposition("p", "totally different")];
		const first = propositionCandidateBatch(search, props, [{ id: "p" }]);
		assert.equal(first.matches[0]!.candidateIds.length, CANDIDATE_PAGE_SIZE);
		assert.deepEqual(first.matches[0]!.candidateIds, ["n0", "n1", "n2", "n3", "n4"]);
		assert.equal(first.matches[0]!.nextOffset, 5);
		const second = propositionCandidateBatch(search, props, [{ id: "p", offset: 5 }]);
		assert.deepEqual(second.matches[0]!.candidateIds, ["n5", "n6"]);
		assert.equal(second.matches[0]!.hasMore, false);
	});
});
