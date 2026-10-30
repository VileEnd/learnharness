/**
 * Drawings in the model context (PR 2, Task 10). Builds the per-turn
 * DrawingContext: the vision-slot reader ALWAYS transcribes the newest active
 * drawing, cached per drawing (DrawingStore transcript cache), whether or not
 * the session model can see images. A multimodal model gets the image AND the
 * transcript; a text-only model gets the transcript alone. A failed
 * transcription is contained: a multimodal model keeps the image, a text-only
 * one gets the "transcription unavailable" line.
 *
 * The image a multimodal model gets is the stored PNG PROCESSED for that
 * model (Pi image processing, its inputLimits.images.resize; upstream
 * 84f9399): the store keeps the original, only the model-facing copy is
 * resized. A PNG that cannot be processed is never sent raw: the model gets
 * the "[Image omitted: …]" note and the transcript still flows.
 *
 * TIME-BOUNDED (final fix wave, 2026-10-28): the reader runs before the turn
 * streams, so a hung provider would hang the turn. After READER_TIMEOUT_MS the
 * request is aborted and the turn proceeds as on a failure (side-channel law).
 */

import {
	activeProblemOf,
	activeWorkOf,
	drawingRefOf,
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
import { processImage } from "../agent/image-processing/index.ts";

/** How long the turn waits for the reader before going on without it. */
export const READER_TIMEOUT_MS = 45_000;

export interface DrawingContextDeps {
	drawingStore: DrawingStore;
	/** Absent when no transcriber model is configured. */
	transcriber?: DrawingTranscriber;
	/** Money channel: the transcription is vision-slot spend, stamped with
	 *  the reader's model (never the session model's rates). */
	onUsage?: (usage: Usage, model: string) => void;
	/** Test seam; production waits READER_TIMEOUT_MS. */
	readerTimeoutMs?: number;
}

/** The drawing ids on markers of the active work/problem (submissions and
 *  hint snapshots), oldest first. */
function activeDrawingIds(messages: readonly LhMessage[]): string[] {
	const active = new Set<string>();
	const work = activeWorkOf(messages);
	if (work) active.add(work.toolCallId);
	const problem = activeProblemOf(messages);
	if (problem) active.add(problem.toolCallId);
	const ids: string[] = [];
	for (const m of messages) {
		const ref = drawingRefOf(m);
		if (ref && active.has(ref.taskId)) ids.push(ref.drawingId);
	}
	return ids;
}

/** Race the reader against the clock; on timeout abort it and throw (the
 *  caller's catch treats it like any reader failure). */
async function withReaderTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`the reader did not answer within ${ms} ms`));
		}, ms);
	});
	try {
		return await Promise.race([run(controller.signal), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

type ModelImage = Pick<NonNullable<ReturnType<DrawingContext["resolve"]>>, "png" | "imageNote">;

/** The canvas PNG as the session model will see it. Never throws: a failed
 *  conversion is the omitted note (side-channel containment). */
async function imageForModel(png: Uint8Array, model: PiEngine["model"]): Promise<ModelImage> {
	try {
		const image = await processImage(png, "image/png", { resizeOptions: model.inputLimits?.images?.resize });
		if (!image.ok) return { imageNote: image.message };
		return {
			png: { data: image.data, mimeType: image.mimeType },
			...(image.hints.length > 0 ? { imageNote: image.hints.join("\n") } : {}),
		};
	} catch {
		return { imageNote: "[Image omitted: could not be converted to a supported inline image format.]" };
	}
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

	// Only the NEWEST active drawing is ever sent; earlier ones are stubs.
	const newest = activeDrawingIds(record.messages as readonly LhMessage[]).at(-1);
	let newestImage: ModelImage | undefined;
	if (modelReadsImages && newest !== undefined) {
		try {
			const png = drawingStore.getPng(chatId, newest);
			if (png) newestImage = await imageForModel(png, engine.model);
		} catch (err) {
			console.error(`[chat ${chatId}] drawing image unavailable:`, err);
		}
	}
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
					const t = await withReaderTimeout(deps.readerTimeoutMs ?? READER_TIMEOUT_MS, (signal) =>
						deps.transcriber!.transcribe(png, structured, { onUsage: deps.onUsage, signal, chatId }),
					);
					drawingStore.writeTranscript(chatId, newest, t);
					transcripts.set(newest, t.text);
				}
			}
		} catch (err) {
			console.error(`[chat ${chatId}] drawing transcription failed:`, err);
		}
	}

	return {
		resolve(drawingId) {
			const scene = drawingStore.getScene(chatId, drawingId);
			if (!scene) return null;
			const box = sceneBoundingBox(scene);
			const structured = box ? serializeSceneStructuredText(scene, box) : "";
			if (modelReadsImages) {
				// Only the newest drawing's image is ever shown (drawingMessage
				// stubs the rest), so only it was processed.
				const image = drawingId === newest ? newestImage : undefined;
				const transcript = transcripts.get(drawingId);
				return {
					...image,
					...(transcript !== undefined ? { transcript } : {}),
					structured,
				};
			}
			const transcript = transcripts.get(drawingId);
			return transcript !== undefined ? { transcript, structured } : { structured };
		},
	};
}
