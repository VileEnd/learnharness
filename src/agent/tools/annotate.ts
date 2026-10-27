/**
 * THE `annotate` TOOL (PR 3, teacher ink): the teacher marks up a submitted drawing - circle,
 * underline, check, cross, note, arrow - anchored to an object id or a grid cell/range. Marks live
 * ONLY in the call (annotationsOf folds them from the record); nothing is written to the drawing.
 * Non-terminating: the teacher keeps talking after it. Every refusal names the valid drawing ids,
 * cells and object ids so a model that guessed wrong can retry.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { annotateInputSchema, annotationMarkProblems, healAnnotateArguments, sceneBoundingBox } from "../../core/canvas-core.ts";
import type { DrawingStore } from "../../core/ports.ts";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";

/** The input schema lives in core (canvas-core), so the record folds parse with exactly what the model faced. */
export const annotateInputObject = annotateInputSchema;

/** Anything that can hand back a chat record's messages (ChatStore and the practice context both do). */
type MessageSource = { getChat(id: string): { messages: readonly unknown[] } | null };

export interface AnnotateToolContext {
	chatId: string;
	drawingStore: Pick<DrawingStore, "getScene">;
	/** Optional: lets a refusal list the chat's real drawing ids. */
	chatStore?: MessageSource;
}

export const ANNOTATE_DESCRIPTION =
	"Mark up the learner's submitted drawing with teacher ink. Each mark has a `kind` (circle, underline, check, cross, note, arrow) " +
	"and a `target` anchored to ONE of: a typed object id (`{\"object\":\"o2\"}`), a freehand stroke id (`{\"stroke\":\"s4\"}`), a grid cell (`{\"cell\":\"C4\"}`) or a grid range (`{\"cells\":\"B2:D3\"}`); " +
	"an arrow takes `from` and `to` instead of `target`. `label` is an optional short caption. " +
	"`drawingId` is the id the submission names (`[drawing drw_...]`). The marks appear on his drawing; this call does not end your turn.";

/** Drawing ids the chat's submissions name, newest last. */
export function drawingIdsOfRecord(messages: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		const d = (m as { role?: string; details?: { drawingId?: unknown } }).details;
		if ((m as { role?: string }).role === "custom" && typeof d?.drawingId === "string" && !ids.includes(d.drawingId)) ids.push(d.drawingId);
	}
	return ids;
}

export function annotateToolFor(ctx: AnnotateToolContext): AgentTool<typeof annotateInputObject> {
	return {
		name: "annotate",
		label: "annotate",
		description: ANNOTATE_DESCRIPTION,
		parameters: annotateInputObject,
		executionMode: "sequential",
		// The nested wobbles (a stringified mark or target, null optionals) heal here; parseAnnotateInput runs
		// the same pass on the raw record, so what the tool accepted is what every reader folds.
		prepareArguments: (args: unknown) => healAnnotateArguments(args) as Static<typeof annotateInputObject>,
		execute: async (_toolCallId, input: Static<typeof annotateInputObject>) => {
			const scene = ctx.drawingStore.getScene(ctx.chatId, input.drawingId);
			if (!scene) {
				const known = drawingIdsOfRecord(ctx.chatStore?.getChat(ctx.chatId)?.messages ?? []);
				return invalidInputResult("annotate", [
					`drawing ${JSON.stringify(input.drawingId)} is not a drawing of this chat` +
						(known.length ? `; this chat's drawings: ${known.join(", ")}` : "; no drawing has been submitted yet"),
				]);
			}
			const box = sceneBoundingBox(scene);
			if (!box) return invalidInputResult("annotate", [`drawing ${input.drawingId} is empty - there is nothing to mark`]);
			const problems = input.marks.flatMap((mark, i) => annotationMarkProblems(mark, scene, box).map((p) => `marks[${i}]: ${p}`));
			if (problems.length > 0) return invalidInputResult("annotate", problems);
			return toToolResult(`Annotated ${input.marks.length} mark${input.marks.length === 1 ? "" : "s"}.`);
		},
	};
}

/** The registry entry: armed on a canvas-capable turn, or when the record already holds a drawing. */
export function annotateToolsFor(ctx: {
	chatId: string;
	chatStore: MessageSource;
	drawingStore?: Pick<DrawingStore, "getScene">;
	canvas?: boolean;
}): Record<string, AgentTool<any>> {
	if (!ctx.drawingStore) return {};
	const armed = ctx.canvas === true || drawingIdsOfRecord(ctx.chatStore.getChat(ctx.chatId)?.messages ?? []).length > 0;
	return armed ? { annotate: annotateToolFor({ chatId: ctx.chatId, drawingStore: ctx.drawingStore, chatStore: ctx.chatStore }) } : {};
}
