/**
 * Drawings in the model context (PR 2, Task 10). Builds the per-turn
 * DrawingContext: a multimodal model gets the newest active drawing as an
 * image; a text-only model gets a vision-slot transcription, cached per
 * drawing (DrawingStore transcript cache). A failed transcription is
 * contained: the resolver then yields the "transcription unavailable" line.
 */

import {
	activeProblemOf,
	activeWorkOf,
	sceneBoundingBox,
	serializeSceneStructuredText,
	type DrawingContext,
	type DrawingStore,
} from "../core/index.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../core/native-messages.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import type { PiEngine } from "../agent/models.ts";
import type { DrawingTranscriber } from "../agent/subagents/drawing-transcriber.ts";

export interface DrawingContextDeps {
	drawingStore: DrawingStore;
	/** Absent when no transcriber model is configured. */
	transcriber?: DrawingTranscriber;
	/** Money channel: the transcription is vision-slot spend. */
	onUsage?: (usage: Usage) => void;
}

/** The drawing ids on markers of the active work/problem, oldest first. */
function activeDrawingIds(messages: readonly LhMessage[]): string[] {
	const active = new Set<string>();
	const work = activeWorkOf(messages);
	if (work) active.add(work.toolCallId);
	const problem = activeProblemOf(messages);
	if (problem) active.add(problem.toolCallId);
	const ids: string[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as { customType?: string; details?: unknown };
		const d = marker.details as { workCallId?: unknown; problemCallId?: unknown; drawingId?: unknown } | null;
		const task = marker.customType === "work-submission" ? d?.workCallId : marker.customType === "practice-thinking" ? d?.problemCallId : undefined;
		if (typeof task === "string" && active.has(task) && typeof d?.drawingId === "string") ids.push(d.drawingId);
	}
	return ids;
}

export async function prepareDrawingContext(
	record: Pick<ChatRecord, "id" | "messages">,
	engine: PiEngine,
	deps: DrawingContextDeps,
): Promise<DrawingContext> {
	const chatId = record.id ?? "";
	const { drawingStore } = deps;
	const modelReadsImages = engine.model.input.includes("image");
	const transcripts = new Map<string, string>();

	if (!modelReadsImages) {
		// Only the NEWEST active drawing is ever sent; earlier ones are stubs.
		const newest = activeDrawingIds(record.messages as readonly LhMessage[]).at(-1);
		if (newest !== undefined) {
			try {
				const cached = drawingStore.readTranscript(chatId, newest);
				if (cached) transcripts.set(newest, cached.text);
				else if (deps.transcriber) {
					const png = drawingStore.getPng(chatId, newest);
					const scene = drawingStore.getScene(chatId, newest);
					if (png) {
						const box = scene ? sceneBoundingBox(scene) : null;
						const structured = scene && box ? serializeSceneStructuredText(scene, box) : "";
						const t = await deps.transcriber.transcribe(png, structured, deps.onUsage);
						drawingStore.writeTranscript(chatId, newest, t);
						transcripts.set(newest, t.text);
					}
				}
			} catch (err) {
				console.error(`[chat ${chatId}] drawing transcription failed:`, err);
			}
		}
	}

	return {
		resolve(drawingId) {
			const scene = drawingStore.getScene(chatId, drawingId);
			if (!scene) return null;
			const box = sceneBoundingBox(scene);
			const structured = box ? serializeSceneStructuredText(scene, box) : "";
			if (modelReadsImages) {
				const png = drawingStore.getPng(chatId, drawingId);
				return png
					? { png: { data: Buffer.from(png).toString("base64"), mimeType: "image/png" }, structured }
					: { structured };
			}
			const transcript = transcripts.get(drawingId);
			return transcript !== undefined ? { transcript, structured } : { structured };
		},
	};
}
