/**
 * Answer events are validated against the pending tool before they are
 * stored (the honest 400). Pure: no LLM, no data dir. Grading stays in the
 * browser, so only the SHAPE and kind are checked, never correctness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ChatInputError, dismissAppends, inputAppends } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

const pose = (tool: string): LhMessage[] => [
	{ ...fauxAssistantMessage([fauxToolCall(tool, { question: "Q?" }, { id: "c1" })], { stopReason: "toolUse" }), id: "a1" },
];
const answer = (a: unknown) => ({ type: "answer" as const, toolCallId: "c1", answer: a as QuestionAnswerData });
const quizAnswer = { kind: "quiz", questionText: "Q?", dontKnow: false, answers: [{ index: 1, label: "A", value: "a" }], correct: true, confidence: 70, answeredAt: "2026-10-01T12:00:00.000Z" };
const verdict = { outcome: "correct", earned: 1, total: 1, items: [{ id: "b1", correct: true }], summary: "s" };
const exerciseAnswer = { kind: "exercise", questionText: "Q?", dontKnow: false, answers: [], format: "numeric", response: { value: "2" }, verdict, attempts: 1, hintsUsed: 0, correct: true, answeredAt: "2026-10-01T12:00:00.000Z" };

describe("answer input validation", () => {
	it("accepts well-formed quiz, ask and exercise answers", () => {
		assert.equal(inputAppends({ messages: pose("quiz") }, answer(quizAnswer)).length, 1);
		assert.equal(inputAppends({ messages: pose("ask_user_question") }, answer({ kind: "ask", questionText: "Q?", dontKnow: false, answers: [], text: "x", answeredAt: "2026-10-01T12:00:00.000Z" })).length, 1);
		assert.equal(inputAppends({ messages: pose("exercise") }, answer(exerciseAnswer)).length, 1);
	});

	it("rejects the garbage from the audit as a ChatInputError", () => {
		const garbage = { kind: "ask", correct: true, answers: "nope", confidence: 9000, answeredAt: "not a date" };
		assert.throws(() => inputAppends({ messages: pose("quiz") }, answer(garbage)), ChatInputError);
	});

	it("rejects a kind that does not match the pending tool", () => {
		assert.throws(() => inputAppends({ messages: pose("quiz") }, answer({ ...quizAnswer, kind: "ask" })), ChatInputError);
		assert.throws(() => inputAppends({ messages: pose("exercise") }, answer(quizAnswer)), ChatInputError);
	});

	it("rejects malformed fields one by one", () => {
		for (const bad of [{ answers: "nope" }, { answers: [{ label: 1, index: 1 }] }, { confidence: 9000 }, { confidence: "70" }, { correct: "yes" }, { answeredAt: "not a date" }, { dontKnow: "no" }, { thinking: 5 }]) {
			assert.throws(() => inputAppends({ messages: pose("quiz") }, answer({ ...quizAnswer, ...bad })), ChatInputError, JSON.stringify(bad));
		}
	});

	it("an exercise answer with a malformed verdict is a ChatInputError, not a TypeError", () => {
		for (const bad of [{ verdict: {} }, { verdict: null }, { verdict: { ...verdict, items: "x" } }, { format: "nope" }, { attempts: -1 }]) {
			assert.throws(() => inputAppends({ messages: pose("exercise") }, answer({ ...exerciseAnswer, ...bad })), ChatInputError, JSON.stringify(bad));
		}
	});

	it("a dismissal is validated the same way", () => {
		const dismissed = { kind: "quiz", questionText: "Q?", dontKnow: false, answers: [], dismissed: true, answeredAt: "2026-10-01T12:00:00.000Z" };
		assert.equal(dismissAppends({ messages: pose("quiz") }, { type: "dismiss", toolCallId: "c1", answer: dismissed as QuestionAnswerData }).length, 1);
		assert.throws(() => dismissAppends({ messages: pose("quiz") }, { type: "dismiss", toolCallId: "c1", answer: { ...dismissed, answers: "x" } as never }), ChatInputError);
	});
});
