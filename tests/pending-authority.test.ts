import assert from "node:assert/strict";
import { test } from "node:test";
import { findPendingToolCall, QUESTION_TOOLS } from "../src/core/pending.ts";
import { activeWorkOf, danglingQuestionOf, pendingQuestionOf, newAnswerResult, newUserMessage, newWorkDismissedMarker, type LhMessage } from "../src/core/native-messages.ts";
import { inputAppends } from "../src/core/input-events.ts";
import { projectView } from "../src/core/view.ts";

function assistant(id: string, ...calls: string[]): LhMessage {
	return {
		id, role: "assistant", content: calls.map(id => ({ type: "toolCall", id, name: "quiz", arguments: { question: id } })),
		stopReason: "toolUse", timestamp: 1, api: "openai-completions", provider: "fixture", model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function pending(messages: LhMessage[], view = projectView(messages)) {
	return findPendingToolCall(view, pendingQuestionOf(messages));
}

test("a later assistant question supersedes an unanswered question in the same projected group", () => {
	const messages = [assistant("old", "old-question"), assistant("new", "new-question")];
	assert.equal(projectView(messages).length, 1, "the view merges both assistant boundaries");
	const question = pending(messages)!;
	assert.equal(question.toolCallId, "new-question");
	assert.doesNotThrow(() => inputAppends({ messages }, { type: "answer", toolCallId: question.toolCallId, answer: { kind: "quiz", answers: [], dontKnow: true } as never }));
});

test("the newest assistant's parallel questions retain call order and never revive older questions", () => {
	const messages = [assistant("old", "old-question"), assistant("new", "first", "second")];
	assert.equal(pending(messages)?.toolCallId, "first");
	messages.push({ ...newAnswerResult("first", "quiz", { kind: "quiz", answers: [], dontKnow: true } as never), id: "answer-first" });
	assert.equal(pending(messages)?.toolCallId, "second");
	messages.push({ ...newAnswerResult("second", "quiz", { kind: "quiz", answers: [], dontKnow: true } as never), id: "answer-second" });
	assert.equal(pending(messages), null);
});

test("the authoritative question still waits for projected input validation", () => {
	const messages = [assistant("old", "old-question"), assistant("new", "new-question")];
	const view = projectView(messages);
	for (const message of view) for (const part of message.parts) {
		if (part.type === "tool-quiz" && part.toolCallId === "new-question") part.state = "input-streaming";
	}
	assert.equal(pending(messages, view), null);
});

// Synthetic compatibility cases, not claims about the affected user's history.
test("reused ids select the newest native question's input, not an older available part", () => {
	const old = assistant("old", "call_0");
	const newer = assistant("new", "call_0");
	if (newer.role === "assistant") newer.content.unshift({ type: "text", text: "new teaching" });
	if (newer.role === "assistant" && newer.content[1]?.type === "toolCall") newer.content[1].arguments = { question: "NEW" };
	const messages = [old, newer];
	const question = pending(messages)!;
	assert.equal(question.messageId, "new");
	assert.equal(question.contentIndex, 1);
	assert.deepEqual(question.input, { question: "NEW" });
	assert.notEqual(question.key, pending([old])!.key);
	assert.deepEqual(danglingQuestionOf(messages), { toolCallId: "call_0", tool: "quiz", input: { question: "NEW" } }, "server authority/shape unchanged");
	const answered = inputAppends({ messages }, { type: "answer", toolCallId: question.toolCallId, answer: { kind: "quiz", answers: [] } as never });
	const parts = projectView([...messages, ...answered]).flatMap(m => m.parts).filter(p => p.type === "tool-quiz");
	assert.equal(parts[0]!.state, "input-available", "old transcript card is untouched");
	assert.equal(parts[1]!.state, "output-available", "result still pairs newest-first");
	assert.equal(pending([...messages, ...answered]), null);
});

for (const state of ["input-streaming", "output-error", "output-available"]) {
	test(`an older available duplicate never bypasses the authoritative part's ${state} state`, () => {
		const messages = [assistant("old", "call_0"), assistant("new", "call_0")];
		const view = projectView(messages);
		const ownPart = view.flatMap(m => m.parts).find(p => p.sourceMessageId === "new" && p.type === "tool-quiz")!;
		ownPart.state = state;
		assert.equal(pending(messages, view), null);
	});
}

test("a missing authoritative part cannot fall back to another occurrence", () => {
	const messages = [assistant("old", "call_0"), assistant("new", "call_0")];
	assert.equal(pending(messages, projectView(messages.slice(0, 1))), null);
});

test("older questions never revive across display groups or after a text-only newest assistant", () => {
	const messages = [assistant("old", "old-q"), newUserMessage("another turn"), assistant("new", "new-q")];
	assert.equal(pending(messages)?.toolCallId, "new-q");
	assert.equal(pending([...messages, newAnswerResult("new-q", "quiz", {} as never)]), null);
	const textOnly = { ...assistant("text"), content: [{ type: "text", text: "done" }] } as LhMessage;
	assert.equal(pending([...messages, textOnly]), null);
});

test("unique question keys survive live-to-persisted message stamps without resetting drafts", () => {
	const live = assistant("c_live", "unique-q");
	const persisted = { ...live, id: "persisted" };
	assert.equal(pending([live])!.key, pending([persisted])!.key);
	assert.notEqual(pending([live])!.messageId, pending([persisted])!.messageId);
});

test("only temporary successful question placeholders are excluded from client pending authority", () => {
	const message = assistant("new", "q");
	const placeholder = { ...newAnswerResult("q", "quiz", {} as never), id: "c_placeholder", details: null };
	for (const tool of QUESTION_TOOLS) {
		const own = { ...placeholder, toolName: tool };
		assert.equal(pendingQuestionOf([message, own])?.toolCallId, "q");
		assert.equal(danglingQuestionOf([message, own]), null, "server/persisted policy does not change");
	}
	for (const result of [
		{ ...placeholder, id: "persisted-null-result" },
		{ ...placeholder, details: undefined },
		{ ...placeholder, isError: true },
		{ ...placeholder, isError: true, content: [{ type: "text" as const, text: "Operation aborted" }] },
		{ ...placeholder, toolName: "visual" },
		{ ...newAnswerResult("q", "quiz", { kind: "quiz", answers: [], dontKnow: true } as never), id: "c_answer" },
	]) {
		assert.equal(pendingQuestionOf([message, result]), null, "real answers, persisted results and failures still resolve the call");
	}
});

test("native occurrence checks preserve every question tool and its own live validation gate", () => {
	for (const tool of QUESTION_TOOLS) {
		const message = assistant("live", "q");
		if (message.role === "assistant" && message.content[0]?.type === "toolCall") message.content[0].name = tool;
		const live = { executions: new Map(), inFlight: true, streamingIds: new Set(["live"]) };
		assert.equal(pending([message], projectView([message], live)), null);
		live.executions.set("q", { isError: false });
		assert.equal(pending([message], projectView([message], live))?.tool, tool);
		live.executions.set("q", { isError: true });
		assert.equal(pending([message], projectView([message], live)), null);
	}
});

// ─── fork cases: numeric/blanks/table/multipart exercise formats, canvas tasks ──────

function call(id: string, name: string, args: Record<string, unknown>, callId: string): LhMessage {
	const m = assistant(id);
	if (m.role === "assistant") m.content = [{ type: "toolCall", id: callId, name, arguments: args as never }];
	return m;
}

test("a numeric question with a call id reused across two turns keeps a distinct draft key", () => {
	const numeric = (question: string) => ({ question, format: "numeric", spec: { answer: "4", mode: "number" } });
	const first = call("turn-1", "exercise", numeric("How many?"), "call_0");
	const second = call("turn-2", "exercise", numeric("How much?"), "call_0");
	const firstKey = pendingQuestionOf([first])!.key;
	assert.equal(firstKey, "call_0", "a unique id keys by id alone");
	const answered = [first, { ...newAnswerResult("call_0", "exercise", {} as never), id: "answer-1" }, second];
	const secondKey = pendingQuestionOf(answered)!.key;
	assert.notEqual(secondKey, firstKey, "the reused id is occurrence-qualified");
	assert.equal(pendingQuestionOf(answered)!.messageId, "turn-2");
	assert.equal(pendingQuestionOf(answered)!.tool, "exercise");
});

test("a placeholder result for a multipart question keeps it pending until the real answer", () => {
	const message = call("m", "exercise", { question: "Parts", format: "multipart", spec: { parts: [] } }, "mp");
	const placeholder = { ...newAnswerResult("mp", "exercise", {} as never), id: "c_ph", details: null };
	assert.equal(pendingQuestionOf([message, placeholder])?.toolCallId, "mp");
	const real = { ...newAnswerResult("mp", "exercise", { kind: "exercise" } as never), id: "c_real" };
	assert.equal(pendingQuestionOf([message, real]), null);
});

test("blanks and table exercises, and the assess twin, pend through a placeholder", () => {
	for (const [tool, format] of [["exercise", "blanks"], ["assess", "table"], ["exercise", "table"], ["assess", "blanks"]] as const) {
		const message = call("m", tool, { question: "Q", format, spec: {} }, "q");
		const placeholder = { ...newAnswerResult("q", tool, {} as never), id: "c_ph", details: null };
		assert.equal(pendingQuestionOf([message, placeholder])?.tool, tool);
	}
});

test("a canvas sketch task is the active work, never a pending dock question", () => {
	const sketch = call("s", "sketch", { prompt: "Draw it" }, "sk1");
	const ack = { ...newAnswerResult("sk1", "sketch", {} as never), id: "c_ack", details: null };
	assert.equal(pendingQuestionOf([sketch, ack]), null, "work is not a dock question");
	assert.equal(pendingQuestionOf([sketch]), null);
	assert.equal(activeWorkOf([sketch, ack])?.toolCallId, "sk1", "pending");
	assert.equal(activeWorkOf([sketch, ack, newWorkDismissedMarker("sk1")]), null, "resolved");
	assert.equal(findPendingToolCall(projectView([sketch, ack]), pendingQuestionOf([sketch, ack])), null);
});

test("a failed newest generation leaves no pending question for the client either", () => {
	const failed = assistant("f", "fq");
	if (failed.role === "assistant") failed.stopReason = "error";
	assert.equal(pendingQuestionOf([assistant("old", "oq"), failed]), null);
	assert.equal(danglingQuestionOf([failed]), null);
});
