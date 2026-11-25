/**
 * Attached images and drawings in the model context (core/attachments.ts). The drawing-context pattern
 * (drawing-context.ts), applied to every attachment of a message or a thinking field:
 *
 * - The CURRENT turn's input (every record message after the last completed assistant message: the user message,
 *   an answer, a practice thinking) is read by the vision-slot reader, one description per attachment, cached in
 *   its store (AttachmentStore for images, DrawingStore for free drawings), so it is paid once. A multimodal
 *   session model also gets the image itself, processed for that model.
 * - OLDER attachments ride as their cached description only ("[image: …]"), which keeps the token cost of a long
 *   session bounded; they are never re-read.
 * - A text-only session model always gets the description.
 * - Nothing here fails a turn: no vision slot, a failed or timed-out reading, a missing file all degrade to
 *   "[Image attached; description unavailable]" (core/attachments.ts). The readings run in parallel under one time
 *   bound (READER_TIMEOUT_MS each, started together), so four attachments wait no longer than one.
 *
 * "Current" is fixed here, once per turn, before the agent loop: toLlmMessages runs at every step of the turn, and
 * the image must stay in view for the whole turn, then become a description from the next one on.
 */

import {
	attachmentsOf,
	sceneBoundingBox,
	serializeSceneStructuredText,
	type AttachmentRef,
	type AttachmentStore,
	type DrawingStore,
} from "../core/index.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type { AttachmentContext, LhMessage } from "../core/native-messages.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import type { PiEngine } from "../agent/models.ts";
import type { DrawingTranscriber } from "../agent/subagents/drawing-transcriber.ts";
import { processImage } from "../agent/image-processing/index.ts";
import { READER_TIMEOUT_MS, withReaderTimeout } from "./drawing-context.ts";

export interface AttachmentContextDeps {
	attachmentStore: AttachmentStore;
	drawingStore: DrawingStore;
	/** Absent when no vision reader is configured. */
	transcriber?: DrawingTranscriber;
	/** Money channel: vision-slot spend, stamped with the reader's model. */
	onUsage?: (usage: Usage, model: string) => void;
	/** Test seam; production waits READER_TIMEOUT_MS. */
	readerTimeoutMs?: number;
}

const key = (ref: AttachmentRef) => `${ref.kind}:${ref.id}`;

/** The attachments of the turn's input: those on record messages after the last completed assistant message. */
export function currentAttachments(messages: readonly LhMessage[]): AttachmentRef[] {
	let start = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string };
		if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
			start = i + 1;
			break;
		}
	}
	const refs: AttachmentRef[] = [];
	for (const m of messages.slice(start)) {
		for (const ref of attachmentsOf(m)) if (!refs.some((r) => key(r) === key(ref))) refs.push(ref);
	}
	return refs;
}

type Resolved = NonNullable<ReturnType<AttachmentContext["resolve"]>>;

/** The bytes of one attachment as stored: a drawing is its exported PNG. */
function bytesOf(chatId: string, ref: AttachmentRef, deps: AttachmentContextDeps): { bytes: Uint8Array; mimeType: string } | null {
	if (ref.kind === "image") return deps.attachmentStore.getImage(chatId, ref.id);
	const png = deps.drawingStore.getPng(chatId, ref.id);
	return png ? { bytes: png, mimeType: "image/png" } : null;
}

function cachedTranscript(chatId: string, ref: AttachmentRef, deps: AttachmentContextDeps): string | undefined {
	try {
		const t = ref.kind === "image" ? deps.attachmentStore.readTranscript(chatId, ref.id) : deps.drawingStore.readTranscript(chatId, ref.id);
		return t?.text;
	} catch {
		return undefined;
	}
}

function structuredOf(chatId: string, ref: AttachmentRef, deps: AttachmentContextDeps): string {
	if (ref.kind !== "drawing") return "";
	const scene = deps.drawingStore.getScene(chatId, ref.id);
	const box = scene ? sceneBoundingBox(scene) : null;
	return scene && box ? serializeSceneStructuredText(scene, box) : "";
}

/** One current attachment: its description (cached, or read now under the time bound) and, for a multimodal model,
 *  the processed image. Never throws. */
async function prepareOne(chatId: string, ref: AttachmentRef, engine: PiEngine, deps: AttachmentContextDeps): Promise<Resolved> {
	const out: Resolved = {};
	let stored: { bytes: Uint8Array; mimeType: string } | null = null;
	try {
		stored = bytesOf(chatId, ref, deps);
	} catch (err) {
		console.error(`[chat ${chatId}] attachment ${ref.id} unreadable:`, err);
	}
	if (!stored) return out;
	const structured = structuredOf(chatId, ref, deps);
	if (structured) out.structured = structured;
	const describe = async () => {
		const cached = cachedTranscript(chatId, ref, deps);
		if (cached !== undefined) return cached;
		if (!deps.transcriber) return undefined;
		const transcriber = deps.transcriber;
		const t = await withReaderTimeout(deps.readerTimeoutMs ?? READER_TIMEOUT_MS, (signal) => {
			const opts = { onUsage: deps.onUsage, signal, chatId };
			return ref.kind === "image" ? transcriber.describeImage(stored!.bytes, stored!.mimeType, opts) : transcriber.transcribe(stored!.bytes, structured, opts);
		});
		if (ref.kind === "image") deps.attachmentStore.writeTranscript(chatId, ref.id, t);
		else deps.drawingStore.writeTranscript(chatId, ref.id, t);
		return t.text;
	};
	const image = async () => {
		if (!engine.model.input.includes("image")) return;
		try {
			const processed = await processImage(stored!.bytes, stored!.mimeType, { resizeOptions: engine.model.inputLimits?.images?.resize });
			if (!processed.ok) {
				out.imageNote = processed.message;
				return;
			}
			out.image = { data: processed.data, mimeType: processed.mimeType };
			if (processed.hints.length > 0) out.imageNote = processed.hints.join("\n");
		} catch {
			out.imageNote = "[Image omitted: could not be converted to a supported inline image format.]";
		}
	};
	const [described] = await Promise.all([
		describe().catch((err: unknown) => {
			console.error(`[chat ${chatId}] attachment ${ref.id} reading failed:`, err);
			return undefined;
		}),
		image(),
	]);
	if (described !== undefined) out.transcript = described;
	return out;
}

export async function prepareAttachmentContext(
	record: Pick<ChatRecord, "id" | "messages">,
	engine: PiEngine,
	deps: AttachmentContextDeps,
): Promise<AttachmentContext> {
	const chatId = record.id ?? "";
	const current = currentAttachments(record.messages as readonly LhMessage[]);
	const prepared = new Map<string, Resolved>();
	await Promise.all(
		current.map(async (ref) => {
			prepared.set(key(ref), await prepareOne(chatId, ref, engine, deps));
		}),
	);
	return {
		resolve(ref) {
			const now = prepared.get(key(ref));
			if (now) return now;
			// An older attachment: its cached description only, read lazily (never a reader call).
			const transcript = cachedTranscript(chatId, ref, deps);
			return transcript !== undefined ? { transcript } : {};
		},
	};
}
