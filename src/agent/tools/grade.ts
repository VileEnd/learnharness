/**
 * THE GRADE TOOL: how a free-recall answer counts. The model judges the
 * learner's own words against the answer it committed; `grade` records that
 * judgment as a tool part in the chat record (a stored judgment, not a
 * hidden field), and the evidence derivation (core/learner.ts) reads it. An
 * answered explain/recall nobody grades produces no evidence.
 *
 * Server-side, normal result (the turn continues). Validation returns to the
 * model as an error result: the question must be an answered explain/recall
 * of THIS chat, one grade per question, a misconception only with partly or
 * wrong. Mechanics only in the description; when and how to grade lives in
 * the prompts.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import { answeredRecallIds, gradedQuestionIds, ungradedAnsweredRecalls } from "../../core/learner.ts";
import { isInputBoundary, visibleTeachingSinceLastInput, workSubmissionsOf, type LhMessage } from "../../core/native-messages.ts";
import type { ChatStore } from "../../core/ports.ts";

import { GRADE_NOTE_MAX, healGradeArguments } from "../../core/grade-heal.ts";

export { GRADE_NOTE_MAX };

export const gradeInputObject = Type.Object({
	question: Type.String({
		description:
			"The toolCallId of the explain, recall, work or sketch call you are grading (it must already have his answer or a submission). Grading a work or sketch call closes it.",
	}),
	grade: Type.Union(
		[Type.Literal("correct"), Type.Literal("partly"), Type.Literal("wrong"), Type.Literal("dontKnow")],
		{ description: "REQUIRED - how his answer counts against your committed answer: correct, partly, wrong or dontKnow (bare words, no quotes)." },
	),
	note: Type.String({
		maxLength: GRADE_NOTE_MAX,
		description: `REQUIRED - one short line (at most ${GRADE_NOTE_MAX} characters): what he had right and what he missed.`,
	}),
	rung: Type.Optional(
		Type.Union(
			[
				Type.Literal("R0"),
				Type.Literal("R1"),
				Type.Literal("R2"),
				Type.Literal("R3"),
				Type.Literal("R4"),
				Type.Literal("R5"),
				Type.Null(),
			],
			{ description: "Only for a work or sketch call: the highest hint rung you gave (R0 to R5), or null when you gave none." },
		),
	),
	misconception: Type.Optional(
		Type.Object(
			{
				term: Type.String({ description: "What he believes or said that is mistaken." }),
				instead: Type.String({ description: "What is true instead." }),
				why: Type.Optional(Type.String({ description: "Why he may think so." })),
			},
			{ description: "Only with partly or wrong: the specific mistaken idea his answer exposed." },
		),
	),
});

/** The refusal's retry aid: the ids `grade` accepts right now, each with its
 *  tool name. A model never sees its own tool-call ids unless a result names
 *  them; a wrong guess must be correctable in one retry. */
function gradableNow(messages: readonly LhMessage[], gradedThisTurn: ReadonlySet<string>): string {
	const names = new Map<string, string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const b of (m as { content: Array<{ type: string; id?: string; name?: string }> }).content) {
			if (b.type === "toolCall" && b.id && b.name) names.set(b.id, b.name);
		}
	}
	const open = ungradedAnsweredRecalls(messages).filter((id) => !gradedThisTurn.has(id));
	if (open.length === 0) return "Nothing is gradable right now (no answered, ungraded question or canvas task with a submission).";
	return `Gradable now: ${open.map((id) => `"${id}" (${names.get(id) ?? "call"})`).join(", ")}.`;
}

/** The soft refusal of a wrong/partly grade on a canvas task's first, uncoached submission. */
export const FIRST_SUBMISSION_REFUSAL =
	"Coach this first submission and leave the task open; grade after he resubmits, asks to stop, or repeats the error.";

/** RC6: true when `grade` of `question` should be refused ONCE: a work/sketch task (not a prediction) with
 *  exactly one submission, no learner-visible coaching since it, and no earlier refused grade for it. All
 *  derived from `messages` (history plus the in-flight turn), never stored. */
function firstSubmissionNeedsCoaching(messages: readonly LhMessage[], question: string): boolean {
	let tool: string | undefined;
	let args: { type?: unknown } = {};
	const gradeCalls = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const b of (m as { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }).content) {
			if (b.type !== "toolCall" || !b.id) continue;
			if (b.id === question && (b.name === "work" || b.name === "sketch")) {
				tool = b.name;
				args = (b.arguments ?? {}) as { type?: unknown };
			}
			if (b.name === "grade" && (b.arguments as { question?: unknown } | undefined)?.question === question) gradeCalls.add(b.id);
		}
	}
	if (tool === undefined || args.type === "predict") return false;
	for (const m of messages) {
		const r = m as { role?: string; toolCallId?: string; isError?: boolean };
		if (r.role === "toolResult" && r.isError && r.toolCallId && gradeCalls.has(r.toolCallId)) return false;
	}
	if (workSubmissionsOf(messages, question).length !== 1) return false;
	return !visibleTeachingSinceLastInput(messages, []);
}

/** The refusal of any grade in a turn that answers a hint request on the same task. */
export const HINT_TURN_REFUSAL =
	"This turn answers his hint request: give the next rung and leave the task open. Grade only after he resubmits, asks to stop, or repeats the error.";

/** True when the learner's latest input (history plus the in-flight turn) is a hint request on `question`:
 *  closing the task then would reveal the committed answer in place of the hint (GLM re-check, 2026-10-27). */
function answersHintRequest(messages: readonly LhMessage[], question: string): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!isInputBoundary(m)) continue;
		const c = m as { customType?: unknown; details?: { callId?: unknown } | null };
		return c.customType === "hint-request" && c.details?.callId === question;
	}
	return false;
}

export function gradeTool(ctx: {
	chatId: string;
	chatStore: Pick<ChatStore, "getChat">;
	/** The in-flight turn (history plus this turn's messages), when the registry has one. */
	turn?: { messages: () => readonly unknown[] };
	/** Called with every question id this registry graded (the work tool's
	 *  intra-turn view of "closed"). */
	onGraded?: (questionId: string) => void;
}): AgentTool<typeof gradeInputObject> {
	// Intra-turn truth (the practice gate's idiom): the record freezes at the
	// turn's write-ahead, so two grades of one question in one turn would
	// both pass the record scan; this set closes that window.
	const gradedThisTurn = new Set<string>();
	return {
		name: "grade",
		label: "grade",
		description:
			"Record how the learner's free-text answer to an explain or recall question - or his work on a canvas task - counts, judged against the answer you committed. " +
			"Call it once per answered question; an answer you never grade is not counted as evidence. " +
			"Grading a work or sketch call closes the task (set rung to the highest hint rung you gave). " +
			"misconception only counts with partly or wrong (it is ignored otherwise).",
		parameters: gradeInputObject,
		executionMode: "sequential",
		// Heal parity: an over-long note is cut and a misconception with correct/dontKnow is dropped here,
		// and core/learner.ts + the grade chip run the same healGradeArguments on the raw record.
		prepareArguments: (args: unknown) => healGradeArguments(args) as Static<typeof gradeInputObject>,
		execute: async (_toolCallId, input) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			const problems: string[] = [];
			if (!record || !answeredRecallIds(record.messages).has(input.question)) {
				problems.push(
					`question "${input.question}" is not an answered explain or recall (or a work/sketch task with a submission) in this chat - copy the toolCallId of the call he answered. ` +
						gradableNow(record?.messages ?? [], gradedThisTurn),
				);
			} else if (gradedQuestionIds(record.messages).has(input.question) || gradedThisTurn.has(input.question)) {
				problems.push(`question "${input.question}" is already graded - one grade per question.`);
			}
			else if (answersHintRequest((ctx.turn?.messages() ?? record.messages) as readonly LhMessage[], input.question)) {
				problems.push(HINT_TURN_REFUSAL);
			}
			else if (
				(input.grade === "wrong" || input.grade === "partly") &&
				firstSubmissionNeedsCoaching((ctx.turn?.messages() ?? record.messages) as readonly LhMessage[], input.question)
			) {
				problems.push(FIRST_SUBMISSION_REFUSAL);
			}
			if (problems.length > 0) return invalidInputResult("grade", problems);
			gradedThisTurn.add(input.question);
			ctx.onGraded?.(input.question);
			return toToolResult(`Recorded: ${input.grade}.`);
		},
	};
}
