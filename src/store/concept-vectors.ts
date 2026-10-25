/**
 * The ConceptVectorStore adapter: the embeddings of the graph's concepts,
 * data/graph/concept-vectors.f32 (little-endian float32, rows x dims) beside
 * concept-vectors.json (model, dims, entries). The sole writer of both.
 * Writes are atomic (tmp + rename), vectors first and json last, so the json
 * only ever points at complete vectors. Reads never throw and never create
 * anything; absent, torn or corrupt reads as null (the concepts are simply
 * embedded again).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { ConceptVectors } from "../core/ports.ts";
import type { ConceptVectorStore } from "../core/ports.ts";

const jsonFile = () => path.join(PATHS.graph, "concept-vectors.json");
const binFile = () => path.join(PATHS.graph, "concept-vectors.f32");

function writeAtomic(file: string, data: string | Uint8Array): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

interface Meta {
	model: string;
	dims: number;
	entries: Record<string, { contentHash: string; offset: number }>;
}

function isMeta(v: unknown): v is Meta {
	const m = v as Meta | null;
	return (
		!!m &&
		typeof m.model === "string" &&
		Number.isInteger(m.dims) &&
		m.dims > 0 &&
		!!m.entries &&
		typeof m.entries === "object" &&
		Object.values(m.entries).every((e) => !!e && typeof e.contentHash === "string" && Number.isInteger(e.offset) && e.offset >= 0)
	);
}

export const conceptVectorStore: ConceptVectorStore = {
	read() {
		try {
			const meta: unknown = JSON.parse(fs.readFileSync(jsonFile(), "utf-8"));
			if (!isMeta(meta)) return null;
			const bytes = fs.readFileSync(binFile());
			if (bytes.length % 4 !== 0) return null;
			const vectors = new Float32Array(bytes.length / 4);
			for (let i = 0; i < vectors.length; i++) vectors[i] = bytes.readFloatLE(i * 4);
			const rows = vectors.length / meta.dims;
			if (!Number.isInteger(rows)) return null;
			if (Object.values(meta.entries).some((e) => e.offset >= rows)) return null;
			return { model: meta.model, dims: meta.dims, entries: meta.entries, vectors };
		} catch {
			return null;
		}
	},
	write(v: ConceptVectors) {
		if (Object.keys(v.entries).length === 0) return;
		if (v.vectors.length % v.dims !== 0) throw new Error("concept vectors are not a whole number of rows");
		const rows = v.vectors.length / v.dims;
		if (Object.values(v.entries).some((e) => e.offset >= rows)) throw new Error("a concept vector entry points past the vectors");
		fs.mkdirSync(PATHS.graph, { recursive: true });
		const bytes = Buffer.alloc(v.vectors.length * 4);
		for (let i = 0; i < v.vectors.length; i++) bytes.writeFloatLE(v.vectors[i]!, i * 4);
		writeAtomic(binFile(), bytes);
		const meta: Meta = { model: v.model, dims: v.dims, entries: v.entries };
		writeAtomic(jsonFile(), `${JSON.stringify(meta)}\n`);
	},
};
