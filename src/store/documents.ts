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
import type { DocumentMeta } from "../core/contracts/documents.ts";
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
};
