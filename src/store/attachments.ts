/**
 * The AttachmentStore adapter: data/attachments/<chatId>/
 *   <img_id>.<png|jpg|webp|gif>   an image the learner attached (content-addressed)
 *   <img_id>.transcript.json      the vision reader's cached description
 * Implements core/ports.ts AttachmentStore. Reads never throw; ids are regex-checked so path-shaped ids read as
 * absent. Writes are atomic (atomic-write.ts). Construction touches nothing (fixture law): folders are created
 * lazily on first write.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { sha256Hex } from "../core/canvas-core.ts";
import { ATTACHMENT_EXT, ATTACHMENT_IMAGE_TYPES, IMAGE_ATTACHMENT_ID, type AttachmentImageType } from "../core/attachments.ts";
import type { AttachmentStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const SAFE = /^[A-Za-z0-9_-]+$/;

const chatDir = (chatId: string) => (SAFE.test(chatId) ? path.join(PATHS.attachments, chatId) : null);

function writeAtomic(file: string, data: Uint8Array | string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, data);
}

function readBytes(file: string): Uint8Array | null {
	try {
		return new Uint8Array(fs.readFileSync(file));
	} catch {
		return null;
	}
}

export const attachmentStore: AttachmentStore = {
	saveImage(chatId, bytes, mimeType) {
		const dir = chatDir(chatId);
		if (!dir) throw new Error("invalid chat id");
		const ext = ATTACHMENT_EXT[mimeType];
		if (!ext) throw new Error("unsupported image type");
		const id = `img_${sha256Hex(bytes).slice(0, 16)}`;
		const file = path.join(dir, `${id}.${ext}`);
		if (!fs.existsSync(file)) writeAtomic(file, bytes);
		return { id };
	},

	getImage(chatId, id) {
		const dir = chatDir(chatId);
		if (!dir || !IMAGE_ATTACHMENT_ID.test(id)) return null;
		for (const mimeType of ATTACHMENT_IMAGE_TYPES) {
			const bytes = readBytes(path.join(dir, `${id}.${ATTACHMENT_EXT[mimeType]}`));
			if (bytes) return { bytes, mimeType: mimeType as AttachmentImageType };
		}
		return null;
	},

	readTranscript(chatId, id) {
		const dir = chatDir(chatId);
		if (!dir || !IMAGE_ATTACHMENT_ID.test(id)) return null;
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.transcript.json`), "utf-8")) as { model?: unknown; text?: unknown } | null;
			return raw && typeof raw.model === "string" && typeof raw.text === "string" ? { model: raw.model, text: raw.text } : null;
		} catch {
			return null;
		}
	},

	writeTranscript(chatId, id, t) {
		const dir = chatDir(chatId);
		if (!dir || !IMAGE_ATTACHMENT_ID.test(id)) throw new Error("invalid id");
		writeAtomic(path.join(dir, `${id}.transcript.json`), JSON.stringify({ model: t.model, text: t.text }));
	},

	deleteForChat(chatId) {
		const dir = chatDir(chatId);
		if (!dir) return;
		fs.rmSync(dir, { recursive: true, force: true });
	},
};
