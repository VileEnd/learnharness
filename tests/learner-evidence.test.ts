/**
 * The learner model's evidence derivation: what counts, how, and for which
 * concepts. Pure: hand-built records, no store, no model.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TENTATIVE_MAX_CONFIDENCE, deriveEvidence, unattributedItems } from "../src/core/learner.ts";
import { chat, conclude, explain, grade, problem, quiz } from "./learner-helpers.ts";

const NODES = new Set(["n1", "n2", "n3"]);

describe("deriveEvidence", () => {
	it("predictions and dismissals are not evidence", () => {
		const c = chat("c1", [
			...quiz("q1", { type: "predict", pick: 2, concepts: ["n1"] }),
			...quiz("q2", { type: "check", dismissed: true, concepts: ["n1"] }),
			...quiz("q3", { type: "check", pick: 1, confidence: 70, concepts: ["n1"] }),
		]);
		const events = deriveEvidence([c], [], NODES);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.result, "clean");
		assert.equal(events[0]!.toolCallId, "q3");
	});

	it("a record without type counts as a check", () => {
		const events = deriveEvidence([chat("c1", quiz("q1", { pick: 1, concepts: ["n1"] }))], [], NODES);
		assert.equal(events.length, 1);
	});

	it("low confidence is tentative", () => {
		assert.equal(TENTATIVE_MAX_CONFIDENCE, 30);
		const events = deriveEvidence([chat("c1", quiz("q1", { pick: 1, confidence: 30, concepts: ["n1"] }))], [], NODES);
		assert.equal(events[0]!.raw, "tentative");
		assert.equal(events[0]!.result, "weak");
	});

	it("the default confidence 50 and an absent confidence are clean", () => {
		const events = deriveEvidence(
			[chat("c1", [...quiz("q1", { pick: 1, confidence: 50, concepts: ["n1"] }), ...quiz("q2", { pick: 1, concepts: ["n1"], tool: "probe" })])],
			[],
			NODES,
		);
		assert.deepEqual(events.map((e) => [e.kind, e.raw, e.result]), [["quiz", "correct", "clean"], ["probe", "correct", "clean"]]);
	});

	it("a quiz miss records the misconception", () => {
		const events = deriveEvidence([chat("c1", quiz("q1", { pick: 2, concepts: ["n1"] }))], [], NODES);
		assert.equal(events[0]!.result, "failed");
		assert.deepEqual(events[0]!.misconception, { term: "P increments", instead: "P decrements" });
		const withNote = deriveEvidence([chat("c1", quiz("q1", { pick: 2, thinking: "mixed them up", concepts: ["n1"] }))], [], NODES);
		assert.deepEqual(withNote[0]!.misconception, { term: "P increments", instead: "P decrements", why: "mixed them up" });
		assert.equal(withNote[0]!.note, "mixed them up");
	});

	it("don't know is a failure without a misconception", () => {
		const events = deriveEvidence([chat("c1", quiz("q1", { dontKnow: true, concepts: ["n1"] }))], [], NODES);
		assert.deepEqual([events[0]!.raw, events[0]!.result, events[0]!.misconception], ["dontKnow", "failed", undefined]);
	});

	it("free recall counts only through a grade, with its mapping and misconception", () => {
		const c = chat("c1", [
			...explain("e1", { concepts: ["n1"] }),
			...explain("e2", { concepts: ["n1"] }),
			...grade("g2", "e2", "partly", { note: "missed the atomicity", misconception: { term: "P is a read", instead: "P is read-modify-write" } }),
			...explain("e3", { concepts: ["n2"], tool: "recall" }),
			...grade("g3", "e3", "correct"),
			...explain("e4", { concepts: ["n3"] }),
			...grade("g4", "e4", "dontKnow"),
		]);
		const events = deriveEvidence([c], [], NODES);
		assert.deepEqual(
			events.map((e) => [e.toolCallId, e.kind, e.raw, e.result]),
			[["e2", "explain", "partly", "weak"], ["e3", "recall", "correct", "clean"], ["e4", "explain", "dontKnow", "failed"]],
		);
		const partly = events.find((e) => e.toolCallId === "e2")!;
		assert.equal(partly.note, "missed the atomicity");
		assert.deepEqual(partly.misconception, { term: "P is a read", instead: "P is read-modify-write" });
	});

	it("a refused grade, a second grade and a graded prediction produce nothing extra", () => {
		const c = chat("c1", [
			...explain("e1", { concepts: ["n1"] }),
			...grade("g1", "e1", "wrong", { isError: true }),
			...explain("e2", { concepts: ["n1"] }),
			...grade("g2", "e2", "correct"),
			...grade("g3", "e2", "wrong"),
			...explain("e3", { concepts: ["n1"], type: "predict" }),
			...grade("g4", "e3", "wrong"),
		]);
		const events = deriveEvidence([c], [], NODES);
		assert.deepEqual(events.map((e) => [e.toolCallId, e.raw]), [["e2", "correct"]]);
	});

	it("practice outcomes hit every target", () => {
		const c = chat(
			"p1",
			[...problem("pr1", ["n1", "n2"]), ...conclude("co1", "surrendered", "never got the swap"), ...problem("pr2", ["n3"]), ...conclude("co2", "solved")],
			"practice",
		);
		const events = deriveEvidence([c], [], NODES);
		const surrendered = events.filter((e) => e.toolCallId === "co1");
		assert.deepEqual(surrendered.map((e) => [e.conceptId, e.result, e.raw]), [["n1", "failed", "surrendered"], ["n2", "failed", "surrendered"]]);
		assert.deepEqual(surrendered[0]!.misconception, { term: "never got the swap" });
		const solved = events.find((e) => e.toolCallId === "co2")!;
		assert.deepEqual([solved.conceptId, solved.result, solved.misconception], ["n3", "clean", undefined]);
	});

	it("practice: solvedWithHints is weak, movedOn fails, dismissed and untagged problems count for nothing", () => {
		const c = chat(
			"p1",
			[
				...problem("a", ["n1"]), ...conclude("ca", "solvedWithHints"),
				...problem("b", ["n1"]), ...conclude("cb", "movedOn", "gave up"),
				...problem("c", ["n1"]), ...conclude("cc", "dismissed"),
				...problem("d"), ...conclude("cd", "solved"),
			],
			"practice",
		);
		const events = deriveEvidence([c], [], NODES);
		assert.deepEqual(events.map((e) => [e.toolCallId, e.result]), [["ca", "weak"], ["cb", "failed"]]);
	});

	it("tags and attributions union, and unknown concept ids are dropped", () => {
		const c = chat("c1", [...quiz("q1", { pick: 1, concepts: ["n1", "n_gone"] }), ...quiz("q2", { pick: 1 })]);
		const rows = [{ chatId: "c1", toolCallId: "q2", conceptIds: ["n3", "n_gone"], at: "2026-10-20T12:00:00.000Z" }];
		const events = deriveEvidence([c], rows, NODES);
		assert.deepEqual(events.map((e) => [e.toolCallId, e.conceptId]).sort(), [["q1", "n1"], ["q2", "n3"]]);
	});
});

describe("unattributedItems", () => {
	it("lists graded, untagged items without a ledger row; practice and predictions never", () => {
		const c = chat("c1", [
			...quiz("q1", { pick: 1 }),
			...quiz("q2", { pick: 1, concepts: ["n1"] }),
			...quiz("q3", { pick: 1, type: "predict" }),
			...quiz("q4", { pick: 1 }),
		]);
		const rows = [{ chatId: "c1", toolCallId: "q4", conceptIds: [], at: "t" }];
		assert.deepEqual(unattributedItems(c, rows).map((i) => i.toolCallId), ["q1"]);
		assert.deepEqual(unattributedItems(chat("p", [...problem("a"), ...conclude("b", "solved")], "practice"), []), []);
	});
});
