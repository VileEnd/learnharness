/** hintsFor: the hint replies of one canvas task / practice problem, derived from the record. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hintsFor, newHintRequest, newThinkingMessage, newWorkSubmission, type LhMessage } from "../src/core/native-messages.ts";

const req = (callId: string, id: string): LhMessage => ({ ...newHintRequest(callId), id });
const say = (id: string, text: string, extra: object = {}): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra }) as unknown as LhMessage;
const sendCall = (id: string, callId: string, message: string): LhMessage =>
	({ id, role: "assistant", content: [{ type: "toolCall", id: callId, name: "send_to_user", arguments: { message } }], stopReason: "toolUse" }) as unknown as LhMessage;
const sendResult = (id: string, callId: string, isError: boolean): LhMessage =>
	({ id, role: "toolResult", toolCallId: callId, toolName: "send_to_user", isError, content: [] }) as unknown as LhMessage;

describe("hintsFor", () => {
	it("pairs each request with its reply text, in order", () => {
		const m = [req("w", "r1"), say("a1", "**Hint (rung 0):** look at the axes"), req("w", "r2"), say("a2", "**Hint (rung 1):** try x = 2")];
		assert.deepEqual(hintsFor(m, "w"), [
			{ requestId: "r1", text: "**Hint (rung 0):** look at the axes" },
			{ requestId: "r2", text: "**Hint (rung 1):** try x = 2" },
		]);
	});

	it("counts a reply delivered through send_to_user", () => {
		const m = [req("w", "r1"), sendCall("a1", "c1", "Hint via tool"), sendResult("t1", "c1", false)];
		assert.deepEqual(hintsFor(m, "w"), [{ requestId: "r1", text: "Hint via tool" }]);
	});

	it("a failed send_to_user does not count", () => {
		const m = [req("w", "r1"), sendCall("a1", "c1", "Hint via tool"), sendResult("t1", "c1", true)];
		assert.deepEqual(hintsFor(m, "w"), [{ requestId: "r1", text: null }]);
	});

	it("a pending request has null text; an errored reply with no text is null too", () => {
		assert.deepEqual(hintsFor([req("w", "r1")], "w"), [{ requestId: "r1", text: null }]);
		const aborted = ({ id: "a1", role: "assistant", content: [], stopReason: "aborted" }) as unknown as LhMessage;
		assert.deepEqual(hintsFor([req("w", "r1"), aborted], "w"), [{ requestId: "r1", text: null }]);
	});

	it("ignores hints for another callId, and another call's request ends the window", () => {
		const m = [req("other", "r0"), say("a0", "other hint"), req("w", "r1"), say("a1", "mine")];
		assert.deepEqual(hintsFor(m, "w"), [{ requestId: "r1", text: "mine" }]);
		const m2 = [req("w", "r1"), req("other", "r2"), say("a2", "for other")];
		assert.deepEqual(hintsFor(m2, "w"), [{ requestId: "r1", text: null }]);
	});

	it("a work-submission between a request and a later reply ends the window", () => {
		const sub = { ...newWorkSubmission("w", "my thinking"), id: "s1" } as LhMessage;
		assert.deepEqual(hintsFor([req("w", "r1"), sub, say("a1", "feedback on the submission")], "w"), [{ requestId: "r1", text: null }]);
	});

	it("joins several text parts of the reply", () => {
		const m = [req("w", "r1"), say("a1", "first"), say("a2", "second")];
		assert.equal(hintsFor(m, "w")[0]?.text, "first\n\nsecond");
	});

	it("works for a practice problem's call id; practice-thinking ends the window", () => {
		const think = { ...newThinkingMessage("prob1", "my attempt"), id: "t1" } as LhMessage;
		const m = [req("prob1", "r1"), say("a1", "nudge"), think, say("a2", "coaching on the attempt"), req("prob1", "r2")];
		assert.deepEqual(hintsFor(m, "prob1"), [
			{ requestId: "r1", text: "nudge" },
			{ requestId: "r2", text: null },
		]);
	});
});
