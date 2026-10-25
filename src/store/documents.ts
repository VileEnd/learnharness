/**
 * The DocumentStore adapter: data/documents/<docId>/document.md (the full
 * markdown) + meta.json. Implements core/ports.ts DocumentStore; the server
 * (src/server/documents.ts) is the only writer. Reads never throw: unknown
 * ids, corrupt metas and path-shaped ids read as absent. Writes are atomic
 * (tmp in the same dir + rename, the push store's idiom), document first and
 * meta last.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { DocumentChunkRef, DocumentMeta, DocumentVectors, PendingBatch } from "../core/contracts/documents.ts";
import type { DocumentStore } from "../core/ports.ts";

const ID = /^doc_[0-9a-f]{12,64}$/;

const dirOf = (id: string) => path.join(PATHS.documents, id);

function writeAtomic(file: string, data: string): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function isMeta(v: unknown): v is DocumentMeta {
	const m = v as DocumentMeta | null;
	return (
		!!m &&
		typeof m.id === "string" &&
		typeof m.contentHash === "string" &&
		typeof m.title === "string" &&
		typeof m.importedAt === "string" &&
		Array.isArray(m.minhash) &&
		Array.isArray(m.sections) &&
		Array.isArray(m.topics) &&
		Array.isArray(m.filenames)
	);
}

function getMeta(id: string): DocumentMeta | null {
	if (!ID.test(id)) return null;
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(dirOf(id), "meta.json"), "utf-8"));
		return isMeta(raw) ? raw : null;
	} catch {
		return null;
	}
}

function writeAtomicBytes(file: string, data: Uint8Array): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

interface ChunksFile {
	model: string;
	dims: number;
	contentHash: string;
	chunks: DocumentChunkRef[];
}

function isChunksFile(v: unknown): v is ChunksFile {
	const c = v as ChunksFile | null;
	return (
		!!c &&
		typeof c.model === "string" &&
		Number.isInteger(c.dims) &&
		c.dims > 0 &&
		typeof c.contentHash === "string" &&
		Array.isArray(c.chunks)
	);
}

const PENDING_FILE = () => path.join(PATHS.documents, "pending-batches.json");

function isPending(v: unknown): v is PendingBatch {
	const p = v as PendingBatch | null;
	return (
		!!p &&
		typeof p.batchId === "string" &&
		typeof p.model === "string" &&
		typeof p.submittedAt === "number" &&
		!!p.docs &&
		typeof p.docs === "object" &&
		Object.values(p.docs).every((d) => typeof d?.contentHash === "string" && Number.isInteger(d.units))
	);
}

export const documentStore: DocumentStore = {
	listMetas() {
		let ids: string[];
		try {
			ids = fs.readdirSync(PATHS.documents);
		} catch {
			return []; // no library yet
		}
		return ids
			.flatMap((id) => {
				const meta = getMeta(id);
				return meta ? [meta] : [];
			})
			.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
	},
	getMeta,
	readMarkdown(id) {
		if (!ID.test(id)) return null;
		try {
			return fs.readFileSync(path.join(dirOf(id), "document.md"), "utf-8");
		} catch {
			return null;
		}
	},
	save(meta, markdown) {
		if (!ID.test(meta.id)) throw new Error(`invalid document id ${meta.id}`);
		const dir = dirOf(meta.id);
		fs.mkdirSync(dir, { recursive: true });
		writeAtomic(path.join(dir, "document.md"), markdown);
		writeAtomic(path.join(dir, "meta.json"), `${JSON.stringify(meta)}\n`);
	},
	remove(id) {
		if (!ID.test(id) || !fs.existsSync(dirOf(id))) return false;
		fs.rmSync(dirOf(id), { recursive: true, force: true });
		return true;
	},
	readVectors(id) {
		const meta = getMeta(id);
		if (!meta) return null;
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(path.join(dirOf(id), "chunks.json"), "utf-8"));
			if (!isChunksFile(raw) || raw.contentHash !== meta.contentHash) return null;
			const bytes = fs.readFileSync(path.join(dirOf(id), "vectors.f32"));
			if (bytes.length !== raw.chunks.length * raw.dims * 4) return null; // torn write
			const vectors = new Float32Array(bytes.length / 4);
			for (let i = 0; i < vectors.length; i++) vectors[i] = bytes.readFloatLE(i * 4);
			return { model: raw.model, dims: raw.dims, contentHash: raw.contentHash, chunks: raw.chunks, vectors };
		} catch {
			return null;
		}
	},
	writeVectors(id, v) {
		if (!ID.test(id)) throw new Error(`invalid document id ${id}`);
		const dir = dirOf(id);
		if (!fs.existsSync(dir)) return; // removed meanwhile
		if (v.vectors.length !== v.chunks.length * v.dims) throw new Error("vectors do not match chunks x dims");
		const bytes = Buffer.alloc(v.vectors.length * 4);
		for (let i = 0; i < v.vectors.length; i++) bytes.writeFloatLE(v.vectors[i]!, i * 4);
		// Little-endian regardless of the host; chunks.json last, so it only ever points at complete vectors.
		writeAtomicBytes(path.join(dir, "vectors.f32"), bytes);
		const chunks: ChunksFile = { model: v.model, dims: v.dims, contentHash: v.contentHash, chunks: v.chunks };
		writeAtomic(path.join(dir, "chunks.json"), `${JSON.stringify(chunks)}\n`);
	},
	readPendingBatches() {
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(PENDING_FILE(), "utf-8"));
			return Array.isArray(raw) ? raw.filter(isPending) : [];
		} catch {
			return [];
		}
	},
	writePendingBatches(batches) {
		fs.mkdirSync(PATHS.documents, { recursive: true });
		writeAtomic(PENDING_FILE(), `${JSON.stringify(batches)}\n`);
	},
};
