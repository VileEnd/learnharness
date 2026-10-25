/**
 * The document library's contracts (PR G): imported source documents -
 * markdown notes and scanned PDFs - with a CONTENT-DERIVED identity. The
 * filename never decides anything; it is kept only as an alias.
 */

/** One heading-delimited stretch of a document. `start`/`end` are char
 *  offsets into the stored markdown (end exclusive); pages come from the
 *  `<!-- page N -->` markers (absent for plain markdown). */
export interface DocumentSection {
	/** Stable within the document: "s1", "s2", ... in reading order. */
	id: string;
	/** The ATX heading chain down to this section ([] before the first heading). */
	headingPath: string[];
	pageFrom?: number;
	pageTo?: number;
	start: number;
	end: number;
}

/** How a document got here. */
export type DocumentOrigin = "markdown" | "pdf";

/** The meta.json of one stored document. */
export interface DocumentMeta {
	/** "doc_" + first 12 hex of (pdfSha256 ?? contentHash). */
	id: string;
	/** sha256 of the normalised text (core/documents.ts normalizeText). */
	contentHash: string;
	/** sha256 of the original PDF bytes (origin "pdf"). */
	pdfSha256?: string;
	/** 128 MinHash values over word 5-shingles - the near-duplicate sketch. */
	minhash: number[];
	title: string;
	summary: string;
	topics: string[];
	/** Every filename this content arrived under - aliases only. */
	filenames: string[];
	importedAt: string;
	updatedAt: string;
	pages?: number;
	origin: DocumentOrigin;
	/** The OCR run that produced the markdown (origin "pdf"). */
	ocr?: { job: string; strategy: string; costUsd: number };
	sections: DocumentSection[];
	/** The graph source id extraction provenance points at (same as `id`). */
	sourceId: string;
}

/** The library list row: the meta without its sketch. */
export type DocumentSummary = Omit<DocumentMeta, "minhash">;

/** The duplicate check's verdict for one candidate file. */
export interface DuplicateVerdict {
	status: "new" | "duplicate" | "similar";
	/** The stored document it matches (duplicate / similar). */
	of?: { id: string; title: string; importedAt: string };
	/** Estimated Jaccard similarity (similar), 1 for an exact duplicate. */
	score?: number;
}

/** What the learner decided for one non-new file. */
export type DocumentDecision = "skip" | "replace" | "new";

// ─── search (PR I) ───────────────────────────────────────────────────────────

/** One retrieval unit's location, as persisted in chunks.json (the text is
 *  re-sliced from document.md by offset - never stored twice). */
export interface DocumentChunkRef {
	sectionId: string;
	/** Char offsets into the stored markdown (end exclusive). */
	start: number;
	end: number;
	pageFrom?: number;
	pageTo?: number;
}

/** The embeddings of one document: vectors.f32 (little-endian float32,
 *  chunks.length x dims, row-major) + chunks.json. `contentHash` ties them
 *  to the text they were computed from - a replaced document invalidates
 *  them on read. */
export interface DocumentVectors {
	model: string;
	dims: number;
	contentHash: string;
	chunks: DocumentChunkRef[];
	vectors: Float32Array;
}
