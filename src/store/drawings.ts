/**
 * The DrawingStore adapter: data/drawings/<chatId>/
 *   <drw_id>.json            the submitted scene (content-addressed)
 *   <drw_id>.png             its rendered snapshot
 *   <drw_id>.transcript.json cached vision transcription
 *   assets/<ast_id>.png|jpg  uploaded images (content-addressed)
 *   drafts/<callId>.json     { rev, scene } the live work-dock draft
 * Implements core/ports.ts DrawingStore. Reads never throw; ids are
 * regex-checked so path-shaped ids read as absent. Writes are atomic
 * (tmp + rename). Construction touches nothing (fixture law): folders are
 * created lazily on first write.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { drawingIdOf, sha256Hex, validateDrawingScene, type DrawingScene } from "../core/canvas-core.ts";
import type { DrawingStore } from "../core/ports.ts";

const DRAWING_ID = /^drw_[0-9a-f]{12}$/;
const ASSET_ID = /^ast_[0-9a-f]{12}$/;
const SAFE = /^[A-Za-z0-9_-]+$/;

const chatDir = (chatId: string) => (SAFE.test(chatId) ? path.join(PATHS.drawings, chatId) : null);

function writeAtomicBytes(file: string, data: Uint8Array | string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function readScene(file: string): DrawingScene | null {
	const v = validateDrawingScene(readJson(file));
	return v.ok ? v.scene : null;
}

function readBytes(file: string): Uint8Array | null {
	try {
		return new Uint8Array(fs.readFileSync(file));
	} catch {
		return null;
	}
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };

export const drawingStore: DrawingStore = {
	saveSubmission(chatId, scene, png) {
		const dir = chatDir(chatId);
		if (!dir) throw new Error("invalid chat id");
		const drawingId = drawingIdOf(scene);
		const sceneFile = path.join(dir, `${drawingId}.json`);
		if (!fs.existsSync(sceneFile)) {
			// png first, scene last: a scene on disk always has its snapshot
			writeAtomicBytes(path.join(dir, `${drawingId}.png`), png);
			writeAtomicBytes(sceneFile, JSON.stringify(scene));
		}
		return { drawingId };
	},

	getScene(chatId, drawingId) {
		const dir = chatDir(chatId);
		if (!dir || !DRAWING_ID.test(drawingId)) return null;
		return readScene(path.join(dir, `${drawingId}.json`));
	},

	getPng(chatId, drawingId) {
		const dir = chatDir(chatId);
		if (!dir || !DRAWING_ID.test(drawingId)) return null;
		return readBytes(path.join(dir, `${drawingId}.png`));
	},

	saveAsset(chatId, bytes, mimeType) {
		const dir = chatDir(chatId);
		if (!dir) throw new Error("invalid chat id");
		const assetId = `ast_${sha256Hex(bytes).slice(0, 12)}`;
		const file = path.join(dir, "assets", `${assetId}.${EXT[mimeType]}`);
		if (!fs.existsSync(file)) writeAtomicBytes(file, bytes);
		return { assetId };
	},

	getAsset(chatId, assetId) {
		const dir = chatDir(chatId);
		if (!dir || !ASSET_ID.test(assetId)) return null;
		for (const [mimeType, ext] of Object.entries(EXT)) {
			const bytes = readBytes(path.join(dir, "assets", `${assetId}.${ext}`));
			if (bytes) return { bytes, mimeType };
		}
		return null;
	},

	readDraft(chatId, callId) {
		const dir = chatDir(chatId);
		if (!dir || !SAFE.test(callId)) return null;
		const raw = readJson(path.join(dir, "drafts", `${callId}.json`)) as { rev?: unknown; scene?: unknown } | null;
		if (!raw || typeof raw.rev !== "number") return null;
		const v = validateDrawingScene(raw.scene);
		return v.ok ? { scene: v.scene, rev: raw.rev } : null;
	},

	writeDraft(chatId, callId, scene, baseRev) {
		const dir = chatDir(chatId);
		if (!dir || !SAFE.test(callId)) throw new Error("invalid id");
		const current = drawingStore.readDraft(chatId, callId);
		if ((current?.rev ?? 0) !== baseRev) return { ok: false, current };
		const rev = baseRev + 1;
		writeAtomicBytes(path.join(dir, "drafts", `${callId}.json`), JSON.stringify({ rev, scene }));
		return { ok: true, rev };
	},

	readTranscript(chatId, drawingId) {
		const dir = chatDir(chatId);
		if (!dir || !DRAWING_ID.test(drawingId)) return null;
		const raw = readJson(path.join(dir, `${drawingId}.transcript.json`)) as { model?: unknown; text?: unknown } | null;
		return raw && typeof raw.model === "string" && typeof raw.text === "string" ? { model: raw.model, text: raw.text } : null;
	},

	writeTranscript(chatId, drawingId, t) {
		const dir = chatDir(chatId);
		if (!dir || !DRAWING_ID.test(drawingId)) throw new Error("invalid id");
		writeAtomicBytes(path.join(dir, `${drawingId}.transcript.json`), JSON.stringify({ model: t.model, text: t.text }));
	},

	deleteForChat(chatId) {
		const dir = chatDir(chatId);
		if (!dir) return;
		fs.rmSync(dir, { recursive: true, force: true });
	},
};
