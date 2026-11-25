/**
 * Message attachments (pure, browser-safe): images and free drawings the learner adds to a chat message or to a
 * thinking field (the quiz/explain answer's "Your thinking", the reading thinking, the practice thinking).
 *
 * On disk an attachment is only a REFERENCE in the record: `{ kind: "image", id: "img_…" }` (the bytes live in the
 * AttachmentStore, data/attachments/<chatId>/) or `{ kind: "drawing", id: "drw_…" }` (a free drawing in the
 * DrawingStore, the same submission files a canvas task writes). The references ride:
 *   - a user message:              `attachments` beside `content` (the record's extra field, like `id`);
 *   - a question answer:           `details.attachments` (its "Your thinking") and `details.readingAttachments`;
 *   - a practice-thinking marker:  `details.attachments`.
 * The record stays the single source of truth: which attachments a message has is read from it, never tracked
 * elsewhere. The limits here are enforced by the server (upload route and input parsing); the browser mirrors them.
 */

import { MAX_PNG_SIDE, checkPngDimensions } from "./image-dimensions.ts";

export type AttachmentKind = "image" | "drawing";
export interface AttachmentRef {
	kind: AttachmentKind;
	id: string;
}

/** At most this many attachments (images and drawings together) on one message or one thinking field. */
export const MAX_ATTACHMENTS = 4;
/** The most one uploaded image may weigh (the canvas photo asset's limit: the client re-encodes far below it). */
export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** The image types the learner may attach (by content, never by name). GIFs are read as their first frame. */
export const ATTACHMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AttachmentImageType = (typeof ATTACHMENT_IMAGE_TYPES)[number];
/** The file picker's accept list. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_IMAGE_TYPES.join(",");

/** Image ids are content-addressed: img_ + the first 16 hex chars of the bytes' sha256. */
export const IMAGE_ATTACHMENT_ID = /^img_[0-9a-f]{16}$/;
/** Free drawings use the DrawingStore's own content id (drawingIdOf). */
export const DRAWING_ATTACHMENT_ID = /^drw_[0-9a-f]{12}$/;

/** The note a model reads when an attachment has no description (no vision slot, a failed or timed-out reading,
 *  or a caller without an attachment context). */
export const ATTACHMENT_UNAVAILABLE_NOTE = "[Image attached; description unavailable]";

/** Is this a well-formed attachment reference (kind and id shape)? */
export function isAttachmentRef(v: unknown): v is AttachmentRef {
	if (typeof v !== "object" || v === null) return false;
	const r = v as { kind?: unknown; id?: unknown };
	if (typeof r.id !== "string") return false;
	if (r.kind === "image") return IMAGE_ATTACHMENT_ID.test(r.id);
	if (r.kind === "drawing") return DRAWING_ATTACHMENT_ID.test(r.id);
	return false;
}

/** Parse a list of attachment references off untrusted input: an array of at most MAX_ATTACHMENTS well-formed,
 *  distinct references, normalised to `{kind, id}` (anything else on an entry is dropped). Throws a readable
 *  message on anything else; the caller turns it into its own 400. */
export function parseAttachmentRefs(v: unknown, where = "attachments"): AttachmentRef[] {
	if (!Array.isArray(v)) throw new Error(`${where} must be a list`);
	if (v.length > MAX_ATTACHMENTS) throw new Error(`${where}: at most ${MAX_ATTACHMENTS} attachments per message`);
	const out: AttachmentRef[] = [];
	for (const item of v) {
		if (!isAttachmentRef(item)) throw new Error(`${where} holds an invalid attachment reference`);
		if (out.some((r) => r.kind === item.kind && r.id === item.id)) throw new Error(`${where} names the same attachment twice`);
		out.push({ kind: item.kind, id: item.id });
	}
	return out;
}

/** The well-formed references of one stored list (a record field); never throws, drops anything malformed. */
export function readAttachmentRefs(v: unknown): AttachmentRef[] {
	return Array.isArray(v) ? v.filter(isAttachmentRef).map((r) => ({ kind: r.kind, id: r.id })) : [];
}

/** Every attachment one record message carries, in display order: a user message's, an answer's thinking then
 *  reading thinking, a practice-thinking marker's. [] for anything else. */
export function attachmentsOf(message: unknown): AttachmentRef[] {
	const m = message as { role?: string; customType?: string; attachments?: unknown; details?: { attachments?: unknown; readingAttachments?: unknown } | null } | null;
	if (!m || typeof m !== "object") return [];
	if (m.role === "user") return readAttachmentRefs(m.attachments);
	if (m.role === "toolResult") return [...readAttachmentRefs(m.details?.attachments), ...readAttachmentRefs(m.details?.readingAttachments)];
	if (m.role === "custom" && m.customType === "practice-thinking") return readAttachmentRefs(m.details?.attachments);
	return [];
}

/** Where the browser loads an attachment's image (tenant-scoped routes under the chat). */
export function attachmentImageUrl(chatId: string, ref: AttachmentRef): string {
	const chat = encodeURIComponent(chatId);
	return ref.kind === "image"
		? `/api/chats/${chat}/attachments/${encodeURIComponent(ref.id)}`
		: `/api/chats/${chat}/drawings/${encodeURIComponent(ref.id)}?format=png`;
}

// ─── the bytes: type by content, dimensions from the header ─────────────────

/** The image type of these bytes by their magic number, or null when they are none of the accepted types. */
export function sniffImageType(bytes: Uint8Array): AttachmentImageType | null {
	const at = (i: number, sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
	if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (at(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
	if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
	return null;
}

/** The file extension an accepted type is stored under. */
export const ATTACHMENT_EXT: Record<AttachmentImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export type ImageDimensions = { ok: true; width: number; height: number } | { ok: false; error: string };

/** Width and height read from the header alone (nothing is decoded), refused over MAX_PNG_SIDE per side: a tiny,
 *  highly compressible file can declare a size whose decode allocates gigabytes (image-dimensions.ts). */
export function checkImageDimensions(bytes: Uint8Array, type: AttachmentImageType): ImageDimensions {
	if (type === "image/png") return checkPngDimensions(bytes);
	const size = type === "image/jpeg" ? jpegSize(bytes) : type === "image/gif" ? gifSize(bytes) : webpSize(bytes);
	if (!size) return { ok: false, error: "image header is incomplete" };
	const { width, height } = size;
	if (width === 0 || height === 0) return { ok: false, error: "image has invalid dimensions" };
	if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) {
		return { ok: false, error: `image is ${width}x${height}; the maximum is ${MAX_PNG_SIDE} pixels per side` };
	}
	return { ok: true, width, height };
}

type Size = { width: number; height: number } | null;

function gifSize(b: Uint8Array): Size {
	if (b.length < 10) return null;
	return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
}

/** The first SOFn frame header's size (baseline, progressive, lossless...). */
function jpegSize(b: Uint8Array): Size {
	let pos = 2;
	while (pos + 4 <= b.length) {
		if (b[pos] !== 0xff) return null;
		const marker = b[pos + 1]!;
		if (marker === 0xff) {
			pos += 1;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			pos += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return null; // end or scan data before any frame header
		const len = (b[pos + 2]! << 8) | b[pos + 3]!;
		if (len < 2) return null;
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			if (pos + 9 > b.length) return null;
			return { height: (b[pos + 5]! << 8) | b[pos + 6]!, width: (b[pos + 7]! << 8) | b[pos + 8]! };
		}
		pos += 2 + len;
	}
	return null;
}

function webpSize(b: Uint8Array): Size {
	if (b.length < 30) return null;
	const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
	if (chunk === "VP8X") {
		return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
	}
	if (chunk === "VP8L") {
		if (b[20] !== 0x2f) return null;
		const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
		return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
	}
	if (chunk === "VP8 ") {
		// Key frame start code 9d 01 2a, then 14-bit width and height.
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
	}
	return null;
}

// ─── what the model reads ───────────────────────────────────────────────────

/** How one attachment reads as text in the model's context (an older message's attachment, or every attachment for
 *  a text-only model): its cached description in a short bracket, or the unavailable note. A drawing names its id,
 *  which `annotate` takes. */
export function attachmentTextNote(ref: AttachmentRef, transcript: string | undefined): string {
	if (ref.kind === "drawing") {
		return transcript ? `[drawing ${ref.id}: ${transcript}]` : `[drawing ${ref.id}] ${ATTACHMENT_UNAVAILABLE_NOTE}`;
	}
	return transcript ? `[image: ${transcript}]` : ATTACHMENT_UNAVAILABLE_NOTE;
}
