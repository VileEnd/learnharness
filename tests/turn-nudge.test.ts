import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newHintRequest, newThinkingMessage, newWorkSubmission, type LhMessage } from "../src/core/native-messages.ts";
import { markSteer, nextNudge, unmarkedSubmission } from "../src/agent/turn-nudge.ts";
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
	it("a submission without a drawing and a hint request are exempt", () => {
		assert.equal(unmarkedSubmission([newWorkSubmission("w1", "x")]), undefined);
		assert.equal(unmarkedSubmission([newHintRequest("w1", 1)]), undefined);
	});
});

describe("nextNudge", () => {
	it("steers once with the drawing id, then never again this turn", () => {
		const unmarked = [sub, assistantText("Look again.")];
		const done = { used: false };
		const first = nextNudge(unmarked, done);
		assert.match(first!, /annotate/);
		assert.equal(first, markSteer("drw_1"));
		assert.equal(nextNudge(unmarked, done), undefined);
	});
});
