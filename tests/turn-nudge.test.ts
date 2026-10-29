import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newHintRequest, newThinkingMessage, newWorkSubmission, type LhMessage } from "../src/core/native-messages.ts";
import { hintMarkSteer, markSteer, nextNudge, SILENT_TURN_STEER, unmarkedSubmission } from "../src/agent/turn-nudge.ts";
import { call, result } from "./learner-helpers.ts";

function assistantText(text: string): LhMessage {
	return {
		id: "t1",
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 3_000,
	} as unknown as LhMessage;
}

const sub = newWorkSubmission("w1", "x", "drw_1");
const marked = [sub, call("a1", "annotate", { drawingId: "drw_1", marks: [] }), result("a1", "annotate", null)];

describe("unmarkedSubmission", () => {
	it("a drawn submission with no annotate is unmarked", () => {
		assert.equal(unmarkedSubmission([sub, assistantText("Look again at the bracket.")]), "drw_1");
	});
	it("a successful annotate marks it", () => {
		assert.equal(unmarkedSubmission([...marked, assistantText("done")]), undefined);
	});
	it("a refused annotate does not count", () => {
		const refused = [sub, call("a1", "annotate", { drawingId: "drw_1", marks: [] }), result("a1", "annotate", null, 2_000, true)];
		assert.equal(unmarkedSubmission(refused), "drw_1");
	});
	it("a practice drawn thinking submission is unmarked too", () => {
		assert.equal(unmarkedSubmission([newThinkingMessage("p1", "x", { drawingId: "drw_2" })]), "drw_2");
	});
	it("an annotate on another drawing does not mark this one", () => {
		const other = [sub, call("a1", "annotate", { drawingId: "drw_9", marks: [] }), result("a1", "annotate", null)];
		assert.equal(unmarkedSubmission(other), "drw_1");
	});
	it("a submission without a drawing and a hint request are exempt", () => {
		assert.equal(unmarkedSubmission([newWorkSubmission("w1", "x")]), undefined);
		assert.equal(unmarkedSubmission([newHintRequest("w1", 1)]), undefined);
	});
	it("a hint request carrying his drawing needs a mark on it", () => {
		assert.equal(unmarkedSubmission([newHintRequest("w1", 1, { drawingId: "drw_h" })]), "drw_h");
		const markedHint = [newHintRequest("w1", 1, { drawingId: "drw_h" }), call("a1", "annotate", { drawingId: "drw_h", marks: [] }), result("a1", "annotate", null)];
		assert.equal(unmarkedSubmission(markedHint), undefined);
	});
});

describe("nextNudge", () => {
	it("steers once with the drawing id, then never again this turn", () => {
		const unmarked = [sub, call("g1", "grade", { question: "w1" }), result("g1", "grade", "ok")];
		const done = { used: false };
		const first = nextNudge(unmarked, done);
		assert.match(first!, /annotate/);
		assert.equal(first, markSteer("drw_1"));
		assert.match(first!, /tell him in plain text/);
		assert.equal(nextNudge(unmarked, done), undefined);
	});
	it("after visible prose, asks only for the marks", () => {
		const first = nextNudge([sub, assistantText("Look again.")], { used: false });
		assert.equal(first, markSteer("drw_1", true));
		assert.match(first!, /mark the drawing; you need not repeat what you said\./);
		assert.doesNotMatch(first!, /tell him in plain text/);
	});
	it("a hint turn with his drawing and no annotate gets the hint mark steer", () => {
		const hint = newHintRequest("w1", 1, { drawingId: "drw_h" });
		const first = nextNudge([hint], { used: false });
		assert.equal(first, "Mark his drawing drw_h where your hint points (a circle or arrow at that spot, its label a short question), then give the hint in plain text.");
		assert.equal(first, hintMarkSteer("drw_h"));
	});
	it("a hint turn that already gave the hint in prose is asked only for the mark", () => {
		const first = nextNudge([newHintRequest("w1", 1, { drawingId: "drw_h" }), assistantText("Look at the sign.")], { used: false });
		assert.equal(first, hintMarkSteer("drw_h", true));
		assert.doesNotMatch(first!, /then give the hint/);
		assert.match(first!, /mark the drawing; you need not repeat what you said\./);
	});
	it("a hint without a drawing gets no mark steer, only the silent rule", () => {
		const first = nextNudge([newHintRequest("w1", 1)], { used: false });
		assert.equal(first, SILENT_TURN_STEER);
		assert.equal(nextNudge([newHintRequest("w1", 1), assistantText("Look at the sign.")], { used: false }), undefined);
	});
});
