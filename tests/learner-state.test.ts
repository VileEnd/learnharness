/**
 * The learner model's STATE derivation: sessions, spaced streaks, review
 * dates, open misconceptions and weak foundations. Pure, fixed clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, GraphChain } from "../src/core/contracts.ts";
import { MIN_SPACING_HOURS, REVIEW_INTERVAL_DAYS, deriveEvidence, deriveLearnerState } from "../src/core/learner.ts";
import { chat, quiz } from "./learner-helpers.ts";

const T = new Date("2026-10-01T10:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;
const at = (ms: number) => new Date(T.getTime() + ms).toISOString();

const ev = (chatId: string, ms: number, result: EvidenceEvent["result"], extra: Partial<EvidenceEvent> = {}): EvidenceEvent => ({
	at: at(ms),
	conceptId: "n1",
	chatId,
	toolCallId: `q_${chatId}_${ms}`,
	kind: "quiz",
	raw: result === "clean" ? "correct" : "miss",
	result,
	...extra,
});

const state = (events: EvidenceEvent[], now: Date, chains: GraphChain[] = [], ids = ["n1"]) => deriveLearnerState(events, chains, ids, now);

describe("deriveLearnerState", () => {
	it("exports the named constants", () => {
		assert.deepEqual([...REVIEW_INTERVAL_DAYS], [3, 7, 21, 60]);
		assert.equal(MIN_SPACING_HOURS, 20);
	});

	it("a concept without evidence is not yet checked", () => {
		const s = state([], T).states.n1!;
		assert.deepEqual([s.state, s.due, s.streak, s.nextReviewAt, s.weakFoundation, s.last, s.history], ["not-yet-checked", false, 0, undefined, false, [], []]);
	});

	it("one clean session is learning, due after 3 days", () => {
		const events = [ev("c1", 0, "clean")];
		const s = state(events, T).states.n1!;
		assert.equal(s.state, "learning");
		assert.equal(s.streak, 1);
		assert.equal(s.nextReviewAt, at(3 * D));
		assert.equal(s.due, false);
		assert.equal(state(events, new Date(T.getTime() + 3 * D + 1000)).states.n1!.due, true);
	});

	it("two spaced clean sessions are solid with a 7-day interval", () => {
		const s = state([ev("c1", 0, "clean"), ev("c2", 21 * H, "clean")], new Date(T.getTime() + 2 * D)).states.n1!;
		assert.equal(s.state, "solid");
		assert.equal(s.streak, 2);
		assert.equal(s.nextReviewAt, at(21 * H + 7 * D));
	});

	it("intervals grow with the streak and stop at 60 days", () => {
		const events = [0, 1, 2, 3, 4].map((i) => ev(`c${i}`, i * D, "clean"));
		const at4 = (n: number) => state(events.slice(0, n), T).states.n1!.nextReviewAt;
		assert.equal(at4(3), at(2 * D + 21 * D));
		assert.equal(at4(4), at(3 * D + 60 * D));
		assert.equal(at4(5), at(4 * D + 60 * D));
	});

	it("same-day sessions don't double count", () => {
		const s = state([ev("c1", 0, "clean"), ev("c2", 2 * H, "clean")], T).states.n1!;
		assert.equal(s.state, "learning");
		assert.equal(s.streak, 1);
		assert.equal(s.nextReviewAt, at(3 * D));
	});

	it("exactly 20 hours of spacing counts, 19 does not", () => {
		assert.equal(state([ev("c1", 0, "clean"), ev("c2", 20 * H, "clean")], T).states.n1!.streak, 2);
		assert.equal(state([ev("c1", 0, "clean"), ev("c2", 19 * H, "clean")], T).states.n1!.streak, 1);
	});

	it("within one session the last event decides", () => {
		const s = state([ev("c1", 0, "failed"), ev("c1", H, "clean")], T).states.n1!;
		assert.equal(s.state, "learning");
		const t = state([ev("c1", 0, "clean"), ev("c1", H, "failed")], T).states.n1!;
		assert.equal(t.state, "shaky");
	});

	it("a slip resets", () => {
		const slip = [ev("c1", 0, "clean"), ev("c2", D, "clean"), ev("c3", 2 * D, "failed")];
		const s = state(slip, T).states.n1!;
		assert.deepEqual([s.state, s.streak, s.nextReviewAt, s.due], ["shaky", 0, undefined, false]);
		const back = state([...slip, ev("c4", 3 * D, "clean")], T).states.n1!;
		assert.deepEqual([back.state, back.streak], ["learning", 1]);
		assert.equal(back.nextReviewAt, at(3 * D + 3 * D));
		assert.equal(state([ev("c1", 0, "clean"), ev("c2", D, "weak")], T).states.n1!.state, "shaky");
	});

	it("default confidence counts as clean", () => {
		const day2 = "2026-10-21T10:00:00.000Z";
		const events = deriveEvidence(
			[
				chat("c1", quiz("q1", { pick: 1, confidence: 50, concepts: ["n1"] })),
				chat("c2", quiz("q2", { pick: 1, confidence: 50, concepts: ["n1"], at: day2 })),
			],
			[],
			new Set(["n1"]),
		);
		const s = deriveLearnerState(events, [], ["n1"], new Date("2026-10-22T00:00:00.000Z")).states.n1!;
		assert.deepEqual([s.state, s.streak], ["solid", 2]);
	});

	it("last holds the newest three first, history all oldest first", () => {
		const events = [0, 1, 2, 3].map((i) => ev(`c${i}`, i * D, "clean"));
		const s = state(events.slice().reverse(), T).states.n1!;
		assert.deepEqual(s.history.map((e) => e.chatId), ["c0", "c1", "c2", "c3"]);
		assert.deepEqual(s.last.map((e) => e.chatId), ["c3", "c2", "c1"]);
	});

	it("misconceptions close on a clean session", () => {
		const miss = ev("c1", 0, "failed", { misconception: { term: "P increments", instead: "P decrements", why: "mixed up" } });
		const open = state([miss], T).states.n1!;
		assert.deepEqual(open.openMisconceptions, [{ term: "P increments", instead: "P decrements", why: "mixed up", at: at(0) }]);
		assert.deepEqual(state([miss, ev("c2", D, "clean")], T).states.n1!.openMisconceptions, []);
	});

	it("a confusion exposed after the last clean session stays open, and repeats are deduplicated by term", () => {
		const events = [
			ev("c1", 0, "failed", { misconception: { term: "old" } }),
			ev("c2", D, "clean"),
			ev("c3", 2 * D, "failed", { misconception: { term: "P increments", why: "first" } }),
			ev("c4", 3 * D, "failed", { misconception: { term: "P increments", why: "again" } }),
			ev("c5", 4 * D, "weak", { misconception: { term: "other" } }),
		];
		const open = state(events, T).states.n1!.openMisconceptions;
		assert.deepEqual(open.map((m) => [m.term, m.why]), [["P increments", "again"], ["other", undefined]]);
	});

	it("weak foundation propagates one level", () => {
		const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, provenance: [], createdAt: at(0) });
		const events = [ev("c1", 0, "failed", { conceptId: "n1" })];
		const s = deriveLearnerState(events, [chain("a1", ["n1"], "n2"), chain("a2", ["n2"], "n3")], ["n1", "n2", "n3"], T).states;
		assert.equal(s.n1!.weakFoundation, false);
		assert.equal(s.n2!.weakFoundation, true);
		assert.equal(s.n3!.weakFoundation, false); // n2 itself is not shaky: one level only
	});

	it("a due premise is a weak foundation too", () => {
		const events = [ev("c1", 0, "clean", { conceptId: "n1" })];
		const chains: GraphChain[] = [{ id: "a1", premises: ["n1", "n9"], conclusion: "n2", provenance: [], createdAt: at(0) }];
		const later = new Date(T.getTime() + 4 * D);
		assert.equal(deriveLearnerState(events, chains, ["n1", "n2"], later).states.n2!.weakFoundation, true);
		assert.equal(deriveLearnerState(events, chains, ["n1", "n2"], T).states.n2!.weakFoundation, false);
	});

	it("events of concepts outside nodeIds are ignored", () => {
		const snap = deriveLearnerState([ev("c1", 0, "clean", { conceptId: "gone" })], [], ["n1"], T);
		assert.deepEqual(Object.keys(snap.states), ["n1"]);
		assert.equal(snap.asOf, T.toISOString());
	});
});
