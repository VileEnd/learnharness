/**
 * Replaced failed attempts (owner ruling 2026-10-30) and failed generations'
 * questions. Pure: no LLM, no data dir.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { danglingQuestionOf, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { inputAppends } from "../src/core/input-events.ts";
import { projectView } from "../src/core/view.ts";
import { FailedAttempt } from "../components/chat.tsx";

const QUIZ = { question: "Q?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "x", type: "check", nodeId: "n" };
const failedWithQuiz = (id: string): LhMessage => ({
	...fauxAssistantMessage([fauxText("partial text"), fauxToolCall("quiz", QUIZ, { id: "q-1" })], { stopReason: "error", errorMessage: "cut off" }), id,
});
const ok = (id: string, text: string): LhMessage => ({ ...fauxAssistantMessage(text), id });
const user = (): LhMessage => newUserMessage("hi");

describe("replaced failed attempts", () => {
	it("collapses a failure a later answer replaced, with no active question", () => {
		const messages = [user(), failedWithQuiz("a1"), ok("a2", "full answer")];
		const view = projectView(messages);
		const group = view.find((m) => m.role === "assistant")!;
		const markers = group.parts.filter((p) => p.type === "failed-attempt");
		assert.equal(markers.length, 1);
		assert.ok(group.parts.some((p) => p.type === "text" && p.text === "full answer"));
		// the failed text and quiz call are nested, never top-level parts
		assert.ok(!group.parts.some((p) => p.type === "text" && p.text === "partial text"));
		assert.ok(!group.parts.some((p) => p.type === "tool-quiz"));
		assert.equal(danglingQuestionOf(messages), null);
	});

	it("keeps a trailing failure as before", () => {
		const view = projectView([user(), failedWithQuiz("a1")]);
		const group = view.find((m) => m.role === "assistant")!;
		assert.ok(!group.parts.some((p) => p.type === "failed-attempt"));
		assert.ok(group.parts.some((p) => p.type === "text" && p.text === "partial text"));
	});

	it("renders collapsed by default", () => {
		const html = renderToStaticMarkup(createElement(FailedAttempt, { parts: [{ type: "text", text: "partial text" }] }));
		assert.match(html, /Attempt failed/);
		assert.match(html, /show/);
		assert.doesNotMatch(html, /partial text/);
	});
});

describe("danglingQuestionOf and failed generations", () => {
	it("a question inside an error generation is not dangling, and its answer is refused", () => {
		const record = { messages: [user(), failedWithQuiz("a1")] };
		assert.equal(danglingQuestionOf(record.messages), null);
		assert.throws(() => inputAppends(record, { type: "answer", toolCallId: "q-1", answer: {} as never }));
	});

	it("a question inside an aborted generation is not dangling", () => {
		const aborted = { ...failedWithQuiz("a1"), stopReason: "aborted" } as LhMessage;
		assert.equal(danglingQuestionOf([user(), aborted]), null);
	});

	it("a question in a clean generation is still dangling", () => {
		const clean = { ...fauxAssistantMessage([fauxToolCall("quiz", QUIZ, { id: "q-2" })], { stopReason: "toolUse" }), id: "a1" } as LhMessage;
		assert.equal(danglingQuestionOf([user(), clean])?.toolCallId, "q-2");
	});
});

describe("retry banner copy", () => {
	it("shows a readable Retry refusal without the generic prefix, keeping the paragraph break", async () => {
		const { TurnErrorBanner } = await import("../components/chat.tsx");
		const html = renderToStaticMarkup(createElement(TurnErrorBanner, { message: "First part.\n\nSecond part.", plain: true }));
		assert.doesNotMatch(html, /Something went wrong/);
		assert.match(html, /First part\.\n\nSecond part\./);
		assert.match(html, /whitespace-pre-line/);
		assert.match(renderToStaticMarkup(createElement(TurnErrorBanner, { message: "boom" })), /Something went wrong: boom/);
	});
});
