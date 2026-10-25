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

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import { answeredRecallIds, gradedQuestionIds } from "../../core/learner.ts";
import type { ChatStore } from "../../core/ports.ts";

export const GRADE_NOTE_MAX = 140;

export const gradeInputObject = Type.Object({
	question: Type.String({
		description: "The toolCallId of the explain or recall call you are grading (it must already have his answer).",
	}),
	grade: Type.Union(
		[Type.Literal("correct"), Type.Literal("partly"), Type.Literal("wrong"), Type.Literal("dontKnow")],
		{ description: "REQUIRED - how his answer counts against your committed answer: correct, partly, wrong or dontKnow (bare words, no quotes)." },
	),
	note: Type.String({
		maxLength: GRADE_NOTE_MAX,
		description: `REQUIRED - one short line (at most ${GRADE_NOTE_MAX} characters): what he had right and what he missed.`,
	}),
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

export function gradeTool(ctx: { chatId: string; chatStore: Pick<ChatStore, "getChat"> }): AgentTool<typeof gradeInputObject> {
	// Intra-turn truth (the practice gate's idiom): the record freezes at the
	// turn's write-ahead, so two grades of one question in one turn would
	// both pass the record scan; this set closes that window.
	const gradedThisTurn = new Set<string>();
	return {
		name: "grade",
		label: "grade",
		description:
			"Record how the learner's free-text answer to an explain or recall question counts, judged against the answer you committed. " +
			"Call it once per answered question; an answer you never grade is not counted as evidence. " +
			"misconception is allowed only with partly or wrong.",
		parameters: gradeInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			const problems: string[] = [];
			if (!record || !answeredRecallIds(record.messages).has(input.question)) {
				problems.push(
					`question "${input.question}" is not an answered explain or recall in this chat - copy the toolCallId of the call he answered.`,
				);
			} else if (gradedQuestionIds(record.messages).has(input.question) || gradedThisTurn.has(input.question)) {
				problems.push(`question "${input.question}" is already graded - one grade per question.`);
			}
			if (input.misconception && input.grade !== "partly" && input.grade !== "wrong") {
				problems.push("misconception is allowed only with grade partly or wrong.");
			}
			if (problems.length > 0) return invalidInputResult("grade", problems);
			gradedThisTurn.add(input.question);
			return toToolResult(`Recorded: ${input.grade}.`);
		},
	};
}
