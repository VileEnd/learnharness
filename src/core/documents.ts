/**
 * The document library's pure core (PR G): content identity, near-duplicate
 * detection, front matter and section parsing. Node-bound (sha256), so -
 * like graph.ts and coverage.ts - it stays out of the core barrel; the
 * server imports it directly.
 *
 * IDENTITY IS CONTENT, NEVER A FILENAME. A document's id is derived from
 * what it says (the PDF's bytes, or the normalised text), so the same notes
 * arriving as "1.md" and "vim notes.md" are one document, and "always
 * re-extract" (the older path-hash design) is replaced by a duplicate check
 * the learner can override (skip / replace / import as new).
 *
 * Near-duplicates ride a MinHash sketch over word 5-shingles: 128 hashes per
 * document, the Jaccard estimate is the fraction of agreeing positions.
 */

import { createHash } from "node:crypto";
import type { DocumentMeta, DocumentSection, DuplicateVerdict } from "./contracts/documents.ts";

/** Similarity at or above this counts as "very similar" (the plan's bar). */
export const SIMILAR_THRESHOLD = 0.85;
export const MINHASH_SIZE = 128;
const SHINGLE_WORDS = 5;

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

// ─── front matter ────────────────────────────────────────────────────────────

/** The block between a leading `---` line and the next `---` line, or null. */
function splitFrontMatter(text: string): { block: string; end: number } | null {
	const open = /^---[ \t]*\r?\n/.exec(text);
	if (!open) return null;
	const rest = text.slice(open[0].length);
	const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
	if (!close) return null;
	return { block: rest.slice(0, close.index), end: open[0].length + close.index + close[0].length };
}

function parseValue(raw: string): unknown {
	const v = raw.trim();
	if (v === "") return "";
	if (/^["[{]/.test(v) || /^-?\d+(\.\d+)?$/.test(v) || v === "true" || v === "false" || v === "null") {
		try {
			return JSON.parse(v);
		} catch {
			// not JSON after all (a YAML flow list with bare words) - fall through
		}
	}
	if (v.startsWith("[") && v.endsWith("]")) {
		return v
			.slice(1, -1)
			.split(",")
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
			.filter((s) => s !== "");
	}
	return v.replace(/^'(.*)'$/, "$1");
}

/** Parse the OCR sidecar's front matter (`key: JSON-ish value` per line:
 *  title, summary, topics, source, pages, sha256, ...). `body` is the text
 *  after the block; `data` is empty and `body` the whole text when absent. */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
	const fm = splitFrontMatter(text);
	if (!fm) return { data: {}, body: text };
	const data: Record<string, unknown> = {};
	for (const line of fm.block.split(/\r?\n/)) {
		const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
		if (m) data[m[1]!] = parseValue(m[2]!);
	}
	return { data, body: text.slice(fm.end) };
}

/** The content-derived metadata an OCR front matter carries, when complete. */
export function describedByFrontMatter(
	data: Record<string, unknown>,
): { title: string; summary: string; topics: string[]; pages?: number; sha256?: string } | null {
	const title = typeof data.title === "string" ? data.title.trim() : "";
	if (title === "") return null;
	const topics = Array.isArray(data.topics) ? data.topics.filter((t): t is string => typeof t === "string") : [];
	return {
		title,
		summary: typeof data.summary === "string" ? data.summary.trim() : "",
		topics: normalizeTopics(topics),
		...(typeof data.pages === "number" && Number.isInteger(data.pages) ? { pages: data.pages } : {}),
		...(typeof data.sha256 === "string" && /^[0-9a-f]{64}$/.test(data.sha256) ? { sha256: data.sha256 } : {}),
	};
}

// ─── normalisation, hashing, MinHash ─────────────────────────────────────────

const PAGE_MARKER = /<!--\s*page\s+(\d+)\s*-->/gi;

/** Strip front matter and page markers and collapse whitespace; lowercased
 *  unless `keepCase` (the describe agent reads the readable form). */
export function normalizeText(text: string, opts: { keepCase?: boolean } = {}): string {
	const fm = splitFrontMatter(text);
	const body = (fm ? text.slice(fm.end) : text).replace(PAGE_MARKER, " ").replace(/\s+/g, " ").trim();
	return opts.keepCase ? body : body.toLowerCase();
}

export function contentHash(text: string): string {
	return sha256Hex(normalizeText(text));
}

/** The document id: content-derived, so a rename never mints a new one. */
export function documentIdFor(ids: { pdfSha256?: string; contentHash?: string }): string {
	const basis = ids.pdfSha256 ?? ids.contentHash;
	if (!basis) throw new Error("a document id needs a pdfSha256 or a contentHash");
	return `doc_${basis.slice(0, 12)}`;
}

/** Word 5-shingles of already-normalised text (a shorter text is one shingle). */
export function shingles(normalized: string): string[] {
	const words = normalized.split(" ").filter((w) => w !== "");
	if (words.length === 0) return [];
	if (words.length <= SHINGLE_WORDS) return [words.join(" ")];
	const out = new Set<string>();
	for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
	return [...out];
}

/** FNV-1a over UTF-16 code units. */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** murmur3's 32-bit finaliser: a cheap, well-mixed permutation. */
function mix(h: number): number {
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

// One fixed seed per sketch position (deterministic, so sketches compare
// across processes and releases).
const SEEDS = Array.from({ length: MINHASH_SIZE }, (_, i) => mix(Math.imul(i + 1, 0x9e3779b1)));

export function minhash(normalized: string): number[] {
	const sig = new Array<number>(MINHASH_SIZE).fill(0xffffffff);
	for (const shingle of shingles(normalized)) {
		const base = fnv1a(shingle);
		for (let i = 0; i < MINHASH_SIZE; i++) {
			const h = mix((base ^ SEEDS[i]!) >>> 0);
			if (h < sig[i]!) sig[i] = h;
		}
	}
	return sig;
}

/** Estimated Jaccard similarity of two sketches (0..1). */
export function jaccardEstimate(a: readonly number[], b: readonly number[]): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return 0;
	let same = 0;
	for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
	return same / n;
}

// ─── topics ──────────────────────────────────────────────────────────────────

/** The matching key of a topic: trimmed, whitespace-collapsed, NFKC, case-folded. */
export function topicKey(topic: string): string {
	return topic.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Trim and dedupe by topicKey, keeping the first display casing. */
export function normalizeTopics(topics: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of topics) {
		const display = raw.replace(/\s+/g, " ").trim();
		const key = topicKey(display);
		if (key === "" || seen.has(key)) continue;
		seen.add(key);
		out.push(display);
	}
	return out;
}

// ─── sections ────────────────────────────────────────────────────────────────

/** Split markdown at ATX headings (# .. ######, fenced code excluded) into
 *  sections carrying their heading chain, page range (from the
 *  `<!-- page N -->` markers) and char offsets into `markdown` as given. */
export function parseSections(markdown: string): DocumentSection[] {
	const fm = splitFrontMatter(markdown);
	const bodyStart = fm ? fm.end : 0;
	interface Open {
		headingPath: string[];
		start: number;
		pageFrom?: number;
		pageTo?: number;
	}
	const sections: DocumentSection[] = [];
	const stack: { level: number; title: string }[] = [];
	let page: number | undefined;
	let open: Open = { headingPath: [], start: bodyStart };
	let fence: string | null = null;
	const close = (end: number) => {
		const text = markdown.slice(open.start, end).replace(PAGE_MARKER, "");
		// A preamble with nothing in it is not a section; a heading always is.
		if (open.headingPath.length === 0 && text.trim() === "") return;
		sections.push({
			id: `s${sections.length + 1}`,
			headingPath: open.headingPath,
			...(open.pageFrom !== undefined ? { pageFrom: open.pageFrom, pageTo: open.pageTo ?? open.pageFrom } : {}),
			start: open.start,
			end,
		});
	};
	// A marker belongs to the text AFTER it: it only extends the open section
	// once content follows, so a heading right after a marker starts on that
	// page instead of dragging the previous section's range forward.
	let pending: number | undefined;
	let offset = bodyStart;
	for (const line of markdown.slice(bodyStart).split("\n")) {
		const lineStart = offset;
		offset += line.length + 1;
		const fenceMark = /^\s{0,3}(```+|~~~+)/.exec(line);
		if (fenceMark) {
			if (fence === null) fence = fenceMark[1]![0]!;
			else if (fenceMark[1]![0] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const marker = /^\s*<!--\s*page\s+(\d+)\s*-->\s*$/i.exec(line);
		if (marker) {
			page = pending = Number(marker[1]);
			continue;
		}
		const heading = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
		if (!heading) {
			if (pending !== undefined && line.trim() !== "") {
				open.pageFrom ??= pending;
				open.pageTo = pending;
				pending = undefined;
			}
			continue;
		}
		pending = undefined;
		close(lineStart);
		const level = heading[1]!.length;
		while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
		stack.push({ level, title: heading[2]!.trim() });
		open = {
			headingPath: stack.map((h) => h.title),
			start: lineStart,
			...(page !== undefined ? { pageFrom: page, pageTo: page } : {}),
		};
	}
	close(markdown.length);
	return sections;
}

// ─── duplicate classification ────────────────────────────────────────────────

type Known = Pick<DocumentMeta, "id" | "title" | "importedAt" | "contentHash" | "pdfSha256" | "minhash">;
type Candidate = Pick<DocumentMeta, "contentHash" | "minhash"> & { pdfSha256?: string };

const ref = (m: Known) => ({ id: m.id, title: m.title, importedAt: m.importedAt });

/** Exact = same PDF bytes or same normalised text; similar = the best
 *  MinHash match at or above SIMILAR_THRESHOLD. The filename never enters. */
export function classify(existing: readonly Known[], candidate: Candidate): DuplicateVerdict {
	const exact = existing.find(
		(m) => (candidate.pdfSha256 !== undefined && m.pdfSha256 === candidate.pdfSha256) || m.contentHash === candidate.contentHash,
	);
	if (exact) return { status: "duplicate", of: ref(exact), score: 1 };
	let best: { meta: Known; score: number } | undefined;
	for (const m of existing) {
		const score = jaccardEstimate(m.minhash, candidate.minhash);
		if (score >= SIMILAR_THRESHOLD && (!best || score > best.score)) best = { meta: m, score };
	}
	return best ? { status: "similar", of: ref(best.meta), score: best.score } : { status: "new" };
}

/** Everything the identity layer derives from a markdown text. */
export function fingerprint(markdown: string): { contentHash: string; minhash: number[]; sections: DocumentSection[] } {
	const normalized = normalizeText(markdown);
	return { contentHash: sha256Hex(normalized), minhash: minhash(normalized), sections: parseSections(markdown) };
}
