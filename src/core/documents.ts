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
import { topicKey } from "./topic-key.ts";

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
	const summary = typeof data.summary === "string" ? data.summary.trim() : "";
	// Early OCR runs (before their naming step) wrote the FILENAME as the
	// title and nothing else. That is no content description: let the
	// describe step read the document instead.
	const source = typeof data.source === "string" ? data.source.trim() : "";
	const sourceStem = source.replace(/\.[^./]+$/, "");
	if (sourceStem !== "" && title === sourceStem) return null;
	return {
		title,
		summary,
		topics: normalizeTopics(topics),
		...(typeof data.pages === "number" && Number.isInteger(data.pages) ? { pages: data.pages } : {}),
		...(typeof data.sha256 === "string" && /^[0-9a-f]{64}$/.test(data.sha256) ? { sha256: data.sha256 } : {}),
	};
}

// ─── normalisation, hashing, MinHash ─────────────────────────────────────────

const PAGE_MARKER = /<!--\s*page\s+(\d+)\s*-->/gi;
/** Whitespace and page markers, runs of them as one: what normalisation turns into a single space. */
const BLANK_RUN = /(?:\s|<!--\s*page\s+\d+\s*-->)+/gi;

/** Characters per normalisation block. Normalising a whole large text with one
 *  `replace` allocates a slice per match (one per word) before it joins them,
 *  a multiple of the text; a block at a time keeps that garbage small. */
const NORMALIZE_BLOCK = 1 << 20;

/** Where the block starting at `from` ends: the first whitespace character at
 *  or after `from + block`, moved past any `<!--` still open there so no page
 *  marker is cut in two. Cutting at whitespace also keeps every word, and the
 *  lowercasing context of a final sigma, inside one block. */
function blockEnd(text: string, from: number, block: number): number {
	let at = from + block;
	for (;;) {
		if (at >= text.length) return text.length;
		const ws = /\s/g;
		ws.lastIndex = at;
		const hit = ws.exec(text);
		if (!hit) return text.length;
		at = hit.index;
		const open = text.lastIndexOf("<!--", at);
		if (open < from) return at;
		const close = text.indexOf("-->", open + 4);
		if (close !== -1 && close < at) return at;
		if (close === -1) return text.length;
		at = close + 3;
	}
}

/** The normalised text (front matter and page markers dropped, whitespace
 *  collapsed, lowercased unless `keepCase`) as consecutive pieces whose
 *  concatenation is exactly what `normalizeText` returns - without ever holding
 *  the whole normalised text. A piece after the first starts with the space
 *  that separates it from the one before; no piece starts or ends mid-word.
 *  `block` is for tests. */
export function* normalizedPieces(text: string, opts: { keepCase?: boolean; block?: number } = {}): Generator<string> {
	const fm = splitFrontMatter(text);
	const block = opts.block ?? NORMALIZE_BLOCK;
	let at = fm ? fm.end : 0;
	let started = false;
	let separated = false; // whitespace seen since the last word
	while (at < text.length) {
		const end = blockEnd(text, at, block);
		const collapsed = text.slice(at, end).replace(BLANK_RUN, " ");
		at = end;
		const lead = collapsed.startsWith(" ");
		const trail = collapsed.length > 1 && collapsed.endsWith(" ");
		const words = collapsed.slice(lead ? 1 : 0, trail ? -1 : undefined);
		if (words === "") {
			separated ||= collapsed !== "";
			continue;
		}
		const piece = started && (separated || lead) ? ` ${words}` : words;
		started = true;
		separated = trail;
		yield opts.keepCase ? piece : piece.toLowerCase();
	}
}

/** Strip front matter and page markers and collapse whitespace; lowercased
 *  unless `keepCase` (the describe agent reads the readable form). */
export function normalizeText(text: string, opts: { keepCase?: boolean } = {}): string {
	return [...normalizedPieces(text, opts)].join("");
}

/** Does the text say anything once normalised? (Page markers and front matter alone do not.) */
export function hasContent(text: string): boolean {
	return !normalizedPieces(text).next().done;
}

export function contentHash(text: string): string {
	const hash = createHash("sha256");
	for (const piece of normalizedPieces(text)) hash.update(piece);
	return hash.digest("hex");
}

/** The document id: content-derived, so a rename never mints a new one. */
export function documentIdFor(ids: { pdfSha256?: string; contentHash?: string }): string {
	const basis = ids.pdfSha256 ?? ids.contentHash;
	if (!basis) throw new Error("a document id needs a pdfSha256 or a contentHash");
	return `doc_${basis.slice(0, 12)}`;
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

/** FNV-1a of the words joined by single spaces: the hash of that shingle's text, without building it. */
function fnv1aWords(words: readonly string[]): number {
	let h = 0x811c9dc5;
	for (let k = 0; k < words.length; k++) {
		if (k > 0) h = Math.imul(h ^ 0x20, 0x01000193);
		const w = words[k]!;
		for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 0x01000193);
	}
	return h >>> 0;
}

/** The MinHash sketch of normalised text given as consecutive pieces that break
 *  between words (see `normalizedPieces`): the same sketch as `minhash` of the
 *  joined text. A sketch keeps the minimum per position, so a repeated shingle
 *  changes nothing and none needs remembering - only the last five words. */
export function minhashOfPieces(pieces: Iterable<string>): number[] {
	const sig = new Array<number>(MINHASH_SIZE).fill(0xffffffff);
	const recent: string[] = [];
	let count = 0;
	const add = (base: number) => {
		for (let i = 0; i < MINHASH_SIZE; i++) {
			const h = mix((base ^ SEEDS[i]!) >>> 0);
			if (h < sig[i]!) sig[i] = h;
		}
	};
	for (const piece of pieces) {
		let from = 0;
		while (from < piece.length) {
			let to = piece.indexOf(" ", from);
			if (to === -1) to = piece.length;
			if (to > from) {
				recent.push(piece.slice(from, to));
				if (recent.length > SHINGLE_WORDS) recent.shift();
				count++;
				if (recent.length === SHINGLE_WORDS) add(fnv1aWords(recent));
			}
			from = to + 1;
		}
	}
	// A text of fewer than five words is one shingle (exactly five was added above).
	if (count > 0 && count < SHINGLE_WORDS) add(fnv1aWords(recent));
	return sig;
}

export function minhash(normalized: string): number[] {
	return minhashOfPieces([normalized]);
}

/** Estimated Jaccard similarity of two sketches (0..1). */
export function jaccardEstimate(a: readonly number[], b: readonly number[]): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return 0;
	let same = 0;
	for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
	return same / n;
}

// ─── adopting old imports ────────────────────────────────────────────────────

/** The source id the pre-library importer minted for an uploaded file name:
 *  "src_" + the first 12 hex of sha256(filename) (extraction.ts importNotes,
 *  git history 543cf33). Unicode normalisation varies by platform, so the
 *  composed and decomposed spellings are both candidates. */
export function legacySourceIds(filename: string): string[] {
	const base = filename.replace(/^.*[\\/]/, "");
	return [...new Set([base, base.normalize("NFC"), base.normalize("NFD")])].map((f) => `src_${sha256Hex(f).slice(0, 12)}`);
}

// ─── topics ──────────────────────────────────────────────────────────────────

export { topicKey };

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
	for (const rawLine of markdown.slice(bodyStart).split("\n")) {
		const lineStart = offset;
		offset += rawLine.length + 1;
		// Offsets stay into `markdown` as given; only the matching ignores a CRLF's \r.
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
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

/** What the identity layer derives from a markdown text. */
export interface Fingerprint {
	contentHash: string;
	minhash: number[];
	sections: DocumentSection[];
}

/** Everything the identity layer derives from a markdown text, in one pass
 *  over the normalised text that never holds all of it. */
export function fingerprint(markdown: string): Fingerprint {
	const hash = createHash("sha256");
	const hashed = (function* () {
		for (const piece of normalizedPieces(markdown)) {
			hash.update(piece);
			yield piece;
		}
	})();
	const sketch = minhashOfPieces(hashed);
	return { contentHash: hash.digest("hex"), minhash: sketch, sections: parseSections(markdown) };
}
