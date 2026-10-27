/**
 * Learner model, question side: `concepts` tags validated at call time, the
 * `grade` tool (validation, registration law) and its quiet chip.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Value } from "typebox/value";
import {
	createProberTools,
	createTeacherTools,
	probeExplainToolFor,
	probeQuizToolFor,
	teachExplainToolFor,
	teachQuizToolFor,
	type TeacherToolContext,
} from "../src/agent/tools.ts";
import { gradeTool, gradeInputObject } from "../src/agent/tools/grade.ts";
import { GradeChip } from "../components/artifacts/grade-chip.tsx";
import type { ChatRecord } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { deriveEvidence } from "../src/core/learner.ts";
import { chat, explain, grade, quiz } from "./learner-helpers.ts";

const graphNodes = () => [
	{ id: "n_sem", name: "Semaphore" },
	{ id: "n_mutex", name: "Mutex" },
];

function storeOf(messages: LhMessage[], extra: Partial<ChatRecord> = {}) {
	const record = { ...chat("c1", messages), ...extra };
	return { getChat: (id: string) => (id === "c1" ? record : null) } as never;
}

const validQuiz = {
	question: "What is 2 + 2?",
	options: [
		{ label: "3", value: "3" },
		{ label: "4", value: "4" },
	],
	correctAnswer: "4",
	explanation: "Arithmetic.",
};
const tree = { nodes: [{ id: "arith" }] } as never;

async function run(tool: { execute: (id: string, input: never) => Promise<unknown> }, input: unknown) {
	return (await tool.execute("call-1", input as never)) as { isError?: boolean; content: { type: string; text: string }[] };
}

describe("concepts tags", () => {
	it("unknown concept ids are refused with the error-back text", async () => {
		const chatStore = storeOf([], { tree });
		const text = `concepts: unknown id "n_nope" - copy ids from the concept files' frontmatter`;
		const cases: [string, { execute: (id: string, input: never) => Promise<unknown> }, Record<string, unknown>][] = [
			["quiz", teachQuizToolFor({ chatId: "c1", chatStore, graphNodes }), { ...validQuiz, type: "check", nodeId: "arith" }],
			["probe", probeQuizToolFor({ graphNodes }), validQuiz],
			["explain", teachExplainToolFor({ chatId: "c1", chatStore, graphNodes }), { type: "check", nodeId: "arith", question: "q", correctAnswer: "a" }],
			["recall", probeExplainToolFor({ graphNodes }), { question: "q", correctAnswer: "a" }],
		];
		for (const [name, tool, input] of cases) {
			const refused = await run(tool, { ...input, concepts: ["n_nope"] });
			assert.equal(refused.isError, true, name);
			assert.match(refused.content[0]!.text, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), name);
			const accepted = await run(tool, { ...input, concepts: ["n_sem"] });
			assert.notEqual(accepted.isError, true, `${name}: a known id is accepted`);
		}
	});

	it("names become ids and an empty list is healed away at the argument seam", () => {
		const probe = probeQuizToolFor({ graphNodes });
		const prepared = probe.prepareArguments!({ ...validQuiz, concepts: ["semaphore", "n_mutex", "Unknown"] }) as { concepts: string[] };
		assert.deepEqual(prepared.concepts, ["n_sem", "n_mutex", "Unknown"]);
		const empty = probe.prepareArguments!({ ...validQuiz, concepts: [] }) as { concepts?: string[] };
		assert.equal(empty.concepts, undefined);
	});

	it("the tag is optional and part of every graded-question schema", () => {
		assert.equal(Value.Check(probeQuizToolFor().parameters, validQuiz), true);
		assert.equal(Value.Check(probeQuizToolFor().parameters, { ...validQuiz, concepts: ["a"] }), true);
		assert.equal(Value.Check(probeExplainToolFor().parameters, { question: "q", correctAnswer: "a", concepts: ["a"] }), true);
		assert.equal(Value.Check(teachQuizToolFor({ chatId: "c1", chatStore: storeOf([]) }).parameters, { ...validQuiz, type: "check", nodeId: "x", concepts: ["a"] }), true);
		assert.equal(Value.Check(teachExplainToolFor({ chatId: "c1", chatStore: storeOf([]) }).parameters, { type: "check", nodeId: "x", question: "q", correctAnswer: "a", concepts: ["a"] }), true);
	});
});

describe("grade", () => {
	it("validates its target", async () => {
		const chatStore = storeOf([...explain("e1"), ...explain("e2"), ...grade("g0", "e2", "correct"), ...quiz("q1", { pick: 1 })]);
		const tool = gradeTool({ chatId: "c1", chatStore });
		const unknown = await run(tool, { question: "nope", grade: "partly", note: "n" });
		assert.equal(unknown.isError, true);
		assert.match(unknown.content[0]!.text, /not an answered explain or recall/);
		const notRecall = await run(tool, { question: "q1", grade: "partly", note: "n" });
		assert.equal(notRecall.isError, true, "a quiz is graded by the client, not by `grade`");
		const already = await run(tool, { question: "e2", grade: "wrong", note: "n" });
		assert.equal(already.isError, true);
		assert.match(already.content[0]!.text, /already graded/);
		const ok = await run(tool, { question: "e1", grade: "partly", note: "got half" });
		assert.notEqual(ok.isError, true);
		assert.equal(ok.content[0]!.text, "Recorded: partly.");
		const twice = await run(tool, { question: "e1", grade: "correct", note: "n" });
		assert.equal(twice.isError, true, "a second grade in the same turn is refused too");
	});

	it("an unanswered explain and a dismissed one cannot be graded", async () => {
		const dismissed = explain("e2");
		(dismissed[1] as { details: unknown }).details = { kind: "explain", questionText: "q", dontKnow: false, answers: [], dismissed: true, answeredAt: "t" };
		const chatStore = storeOf([dismissed[0]!, dismissed[1]!, explain("e1")[0]!]);
		const tool = gradeTool({ chatId: "c1", chatStore });
		assert.equal((await run(tool, { question: "e1", grade: "correct", note: "n" })).isError, true);
		assert.equal((await run(tool, { question: "e2", grade: "correct", note: "n" })).isError, true);
	});

	it("a misconception sent with correct or dontKnow is healed away at the boundary and in the fold, not refused", async () => {
		const chatStore = storeOf([...explain("e1"), ...explain("e2"), ...explain("e3")]);
		const tool = gradeTool({ chatId: "c1", chatStore });
		const misconception = { term: "P increments", instead: "P decrements" };
		const healed = (args: unknown) => tool.prepareArguments!(args as never) as Record<string, unknown>;
		assert.equal("misconception" in healed({ question: "e1", grade: "correct", note: "n", misconception }), false);
		assert.equal("misconception" in healed({ question: "e2", grade: "dontKnow", note: "n", misconception }), false);
		assert.deepEqual(healed({ question: "e3", grade: "wrong", note: "n", misconception }).misconception, misconception);
		const ok = await run(tool, healed({ question: "e1", grade: "correct", note: "n", misconception }));
		assert.notEqual(ok.isError, true);
		// the RAW record (misconception still on a correct grade) never reaches the evidence
		const msgs = [...explain("e1", { concepts: ["n1"] }), ...grade("g1", "e1", "correct", { misconception })];
		const events = deriveEvidence([chat("c1", msgs)], [], new Set(["n1"]) as never);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.misconception, undefined);
	});

	it("a long note is truncated at a word boundary within 140 characters, not refused", async () => {
		const long = "he had the sign right but missed the factor of two when differentiating the exponent ".repeat(4).trim();
		const chatStore = storeOf(explain("e1"));
		const tool = gradeTool({ chatId: "c1", chatStore });
		const healed = tool.prepareArguments!({ question: "e1", grade: "partly", note: long } as never) as { note: string };
		assert.ok(healed.note.length <= 140 && healed.note.endsWith("\u2026"));
		assert.ok(long.startsWith(healed.note.slice(0, -1)));
		assert.equal(long[healed.note.length - 1], " ", "cut at a word boundary");
		assert.equal(Value.Check(gradeInputObject, healed), true);
		assert.notEqual((await run(tool, healed)).isError, true);
		// the fold and the chip read the raw record with the same heal
		const events = deriveEvidence([chat("c1", [...explain("e1", { concepts: ["n1"] }), ...grade("g1", "e1", "partly", { note: long })])], [], new Set(["n1"]) as never);
		assert.ok(events[0]!.note!.length <= 140 && events[0]!.note!.endsWith("\u2026"));
		const html = renderToStaticMarkup(React.createElement(GradeChip, { part: { type: "tool-grade", state: "output-available", input: { grade: "partly", note: long } } as never }));
		assert.ok(html.includes("\u2026"));
	});

	it("the note is at most 140 characters; grade values are closed", () => {
		const base = { question: "e1", grade: "partly", note: "x".repeat(140) };
		assert.equal(Value.Check(gradeInputObject, base), true);
		assert.equal(Value.Check(gradeInputObject, { ...base, note: "x".repeat(141) }), false);
		assert.equal(Value.Check(gradeInputObject, { ...base, grade: "great" }), false);
		assert.equal(Value.Check(gradeInputObject, { ...base, misconception: { term: "t" } }), false, "instead is required");
	});

	it("stays available while an answer is ungraded, even with free recall off", () => {
		const answered = explain("e1");
		const base = { jobStore: {} as never, spawn: () => {}, libraryRoot: "/nonexistent-library" };
		const teacherCtx = (messages: LhMessage[]): TeacherToolContext => ({ chatId: "c1", chatStore: storeOf(messages), ...base });
		assert.ok(createTeacherTools(teacherCtx(answered), { explain: false }).grade, "teacher: ungraded explain pending");
		assert.equal(createTeacherTools(teacherCtx([...answered, ...grade("g1", "e1", "correct")]), { explain: false }).grade, undefined, "teacher: nothing pending");
		assert.equal(createTeacherTools(teacherCtx([]), { explain: false }).grade, undefined, "teacher: choice mechanic, nothing pending");
		assert.ok(createTeacherTools(teacherCtx([]), { explain: true }).grade, "teacher: free recall armed");
		const proberCtx = (messages: LhMessage[]) => ({ chatId: "c1", chatStore: storeOf(messages), deliver: () => {}, ...base });
		assert.ok(createProberTools(proberCtx(explain("e1", { tool: "recall" })), { explain: false }).grade, "prober: ungraded recall pending");
		assert.equal(createProberTools(proberCtx([]), { explain: false }).grade, undefined);
		assert.ok(createProberTools(proberCtx([]), { explain: true }).grade);
	});
});

describe("grade chip", () => {
	const part = (input: unknown, state = "output-available") => ({ type: "tool-grade", state, toolCallId: "g1", input });
	it("renders `counted as: partly` quietly", () => {
		const html = renderToStaticMarkup(React.createElement(GradeChip, { part: part({ question: "e1", grade: "partly", note: "half" }) }));
		assert.match(html, /counted as: partly/);
		assert.match(html, /title="half"/);
	});
	it("renders nothing for a refused call or a malformed input", () => {
		assert.equal(renderToStaticMarkup(React.createElement(GradeChip, { part: part({ grade: "partly" }, "output-error") })), "");
		assert.equal(renderToStaticMarkup(React.createElement(GradeChip, { part: part({ grade: "great" }) })), "");
		assert.equal(renderToStaticMarkup(React.createElement(GradeChip, { part: part(undefined, "input-streaming") })), "");
	});
});
