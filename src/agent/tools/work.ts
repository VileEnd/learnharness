/**
 * THE CANVAS TASK TOOLS: `work` (teacher) and `sketch` (prober). The agent
 * poses ONE canvas task; the call acks and ends the turn (terminate), and
 * the learner's submissions arrive as labeled `work-submission` markers
 * until `grade` (or a dismissal) closes the task. The open task is a record
 * fold (activeWorkOf), never tracked state.
 *
 * Side questions (quiz/explain/exercise/ask) stay allowed while a task is
 * open; only a SECOND canvas task is refused. The tools exist only on a
 * canvas-capable turn (tools.ts registers them when ctx.canvas is true).
 *
 * Mechanics only in the descriptions; when to use the canvas lives in the
 * prompts.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { sketchInputObject, workInputObject, workInputProblems } from "../../core/question-core.ts";
import { activeWorkOf } from "../../core/native-messages.ts";
import type { ChatStore } from "../../core/ports.ts";
import { invalidInputResult, workResult } from "../tool-execute.ts";
import {
	conceptsProblems,
	nodeIdProblem,
	prepareQuestionArgumentsFor,
	teachGuardFor,
	type ConceptNodes,
	type TeachTurnView,
} from "../tools.ts";

/** The turn-scoped intra-turn truth the stored record cannot hold: question
 *  ids `grade` closed THIS turn (the record freezes at the write-ahead, so a
 *  grade then a new pose in one turn must still see the task as closed). */
export interface WorkGate {
	graded: Set<string>;
}

export function newWorkGate(): WorkGate {
	return { graded: new Set() };
}

export interface WorkToolContext {
	chatId: string;
	chatStore: Pick<ChatStore, "getChat">;
	graphNodes?: ConceptNodes;
	turn?: TeachTurnView;
	workGate?: WorkGate;
}

function description(name: "work" | "sketch", teach: boolean): string {
	return (
		"Pose a CANVAS TASK: the learner works on a drawing canvas (with a written \"Your thinking\" field), " +
		"submits as often as they like, and you coach between submissions. " +
		"The task stays open - the learner's submissions arrive as labeled messages - until you close it with `grade` " +
		"(question = this call's id) or the learner dismisses it. " +
		"correctAnswer is what a correct solution contains, COMMITTED before the learner sees the task. " +
		(teach
			? "Every call declares `type` (the question's role in the teaching cycle) and `nodeId` (required, the plan node this task is about - validated at call time). "
			: "") +
		"Set `requireThinking` to true to require written thinking with each submission. " +
		"ONE canvas task at a time: this call is refused while one is open. " +
		"Call a single " +
		name +
		", then end your turn."
	);
}

/** Refusal text when a canvas task is already open (null = free to pose). */
function openTaskProblem(ctx: WorkToolContext): string | null {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const active = record ? activeWorkOf(record.messages) : null;
	if (!active || ctx.workGate?.graded.has(active.toolCallId)) return null;
	return (
		`A canvas task is already open (call ${active.toolCallId}) - one canvas task at a time. ` +
		"Wait for the learner's submission and grade it (or let the learner dismiss it) before posing another. " +
		"Quiz, explain, exercise and ask questions are still allowed meanwhile."
	);
}

/** The teacher's `work` tool. */
export function teachWorkToolFor(ctx: WorkToolContext): AgentTool<typeof workInputObject> {
	const guard = teachGuardFor(ctx.turn);
	return {
		name: "work",
		label: "work",
		description: description("work", true),
		parameters: workInputObject,
		prepareArguments: prepareQuestionArgumentsFor<Static<typeof workInputObject>>(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const problems = [...workInputProblems(input), ...conceptsProblems(ctx.graphNodes, input.concepts)];
			const nodeIdProblemText = nodeIdProblem(ctx as Parameters<typeof nodeIdProblem>[0], input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			const open = openTaskProblem(ctx);
			if (open) problems.push(open);
			if (problems.length > 0) return invalidInputResult("work", problems);
			const refusal = guard("work", input.type);
			if (refusal) return invalidInputResult("work", [refusal]);
			return workResult(toolCallId);
		},
	};
}

/** The prober's `sketch` tool: no `type`, no `nodeId`. */
export function probeSketchToolFor(ctx: Omit<WorkToolContext, "turn">): AgentTool<typeof sketchInputObject> {
	return {
		name: "sketch",
		label: "sketch",
		description: description("sketch", false),
		parameters: sketchInputObject,
		prepareArguments: prepareQuestionArgumentsFor<Static<typeof sketchInputObject>>(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const problems = [...workInputProblems(input), ...conceptsProblems(ctx.graphNodes, input.concepts)];
			const open = openTaskProblem(ctx);
			if (open) problems.push(open);
			if (problems.length > 0) return invalidInputResult("sketch", problems);
			return workResult(toolCallId);
		},
	};
}
