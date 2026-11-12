/**
 * Document search, pure (PR I): the scoring and slicing the document index
 * (src/server/doc-index.ts) and the teacher's document tools run on.
 * Browser-safe - no node imports, no I/O, deterministic.
 *
 *   tokenize        German/English folding (lowercase, umlaut -> ae/oe/ue AND a
 *                   plain a/o/u variant, ss for the sharp s, accents stripped,
 *                   a light plural stemmer); math-ish pieces such as o(n),
 *                   ll(1), c++ survive whole
 *   Bm25            incremental inverted index (k1 1.2, b 0.75)
 *   cosine / rrf    the vector side and the fusion (Reciprocal Rank Fusion, k 60)
 *   chunkDocument   sections -> retrieval units of about 1200 chars, split at
 *                   paragraph boundaries, each keeping its heading path, page
 *                   range and char offsets into the stored markdown
 *   snippetAround   a plain-text excerpt around the best match
 *   sliceDocument   the exact stored text of a section or page range, with
 *                   page markers, capped
 */

import type { DocumentSection } from "./contracts/documents.ts";

// ─── shared result shapes (index <-> tools <-> API <-> UI) ───────────────────

export interface DocSearchHit {
	/** "section": a passage of a stored document; "concept": a knowledge-graph
	 *  concept (docId and sectionId are "", conceptId is set). Persisted tool
	 *  parts from before concepts joined the search lack `kind` and `path`:
	 *  readers treat a missing kind as "section". */
	kind: "section" | "concept";
	/** Where the hit lives in the library bundle (OKF), relative to its root:
	 *  `documents/<doc>/<sNN>-<slug>.md` or `concepts/<slug>.md`. */
	path: string;
	docId: string;
	conceptId?: string;
	/** The document title, or the concept's name. */
	title: string;
	sectionId: string;
	headingPath: string[];
	pageFrom?: number;
	pageTo?: number;
	/** Plain text (no highlighting), about 300 chars around the best match. */
	snippet: string;
	score: number;
}

export interface DocSearchResult {
	/** "hybrid": the vector ranking contributed; "keyword": BM25 only. */
	mode: "hybrid" | "keyword";
	query: string;
	hits: DocSearchHit[];
	/** Why the result is weaker than it could be (honest degradation). */
	note?: string;
}

export interface DocSearchQuery {
	topic?: string;
	/** A docId or (part of) a title. Concepts match only when their provenance
	 *  is a matching document. */
	document?: string;
	limit?: number;
	/** false = document passages only (the /documents page has no reader for a concept). Default true. */
	includeConcepts?: boolean;
	/** true = concept hits only (no document passages): the learner-model attribution searches the library for the concepts a question tests. */
	conceptsOnly?: boolean;
}

export interface DocListEntry {
	docId: string;
	title: string;
	topics: string[];
	pages?: number;
}

export type DocReadResult =
	| {
			ok: true;
			docId: string;
			title: string;
			/** "outline": the section list; "slice": stored text. */
			kind: "outline" | "slice";
			/** Human label of what was read: "§ A > B", "pages 3-4". */
			label: string;
			sectionId?: string;
			headingPath?: string[];
			pageFrom?: number;
			pageTo?: number;
			text: string;
			truncated: boolean;
			nextOffset?: number;
	  }
	| { ok: false; error: string };

export interface DocReadQuery {
	section?: string;
	/** "4" or "3-5". */
	pages?: string;
	/** Continue a truncated read at this char offset of the selection. */
	offset?: number;
}

// ─── tokenizer ───────────────────────────────────────────────────────────────

/** o(n), ll(1), o(n log n), c++, c# - kept whole (spaces removed) next to their parts. */
const MATHISH = /[\p{L}\p{N}_]+\([^()\n]{1,24}\)[\p{L}\p{N}]*|\p{L}+(?:\+\+|#)(?![\p{L}\p{N}])/gu;
const UMLAUT = /[äöü]/;

function stripMarks(s: string): string {
	return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Light German/English plural stemmer: alphabetic words of 5+ letters lose
 *  one common suffix (Semaphoren/Semaphore -> semaphor, locks -> lock). */
function stem(t: string): string {
	if (t.length < 5 || !/^\p{L}+$/u.test(t)) return t;
	for (const suffix of ["en", "er", "es", "e", "n", "s"]) {
		if (!t.endsWith(suffix) || t.length - suffix.length < 4) continue;
		if (suffix === "s" && t.endsWith("ss")) continue;
		return t.slice(0, -suffix.length);
	}
	return t;
}

/** The folded forms of one word: the ae/oe/ue form and, for words with an
 *  umlaut, the plain a/o/u form (so "Mutter" finds "Mütter" and "Maerchen"
 *  finds "Märchen"). */
function fold(word: string): string[] {
	const lower = word.toLowerCase().replace(/ß/g, "ss");
	const primary = stripMarks(lower.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue"));
	const out = [stem(primary)];
	if (UMLAUT.test(lower)) {
		const plain = stem(stripMarks(lower));
		if (plain !== out[0]) out.push(plain);
	}
	return out;
}

/** Text -> index/query tokens (duplicates kept: term frequency counts). */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(MATHISH)) out.push(m[0].toLowerCase().replace(/\s+/g, ""));
	for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
		// Single letters are noise; a lone number is not ("Aufgabe 3").
		if (word.length < 2 && !/^\p{N}$/u.test(word)) continue;
		out.push(...fold(word));
	}
	return out;
}

/** Plain folded form for filters and title matching: lowercase, ae/oe/ue/ss,
 *  accents stripped, punctuation to single spaces. No stemming, no variants,
 *  so a substring test between two folded strings is meaningful. */
export function foldKey(text: string): string {
	return stripMarks(text.toLowerCase().replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue"))
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

// ─── BM25 ────────────────────────────────────────────────────────────────────

/** A typed array with room for at least `min` elements (doubling; contents kept). */
function grown<T extends Uint8Array | Uint32Array>(a: T, min: number): T {
	if (a.length >= min) return a;
	let n = Math.max(a.length, 16);
	while (n < min) n *= 2;
	const out = new (a.constructor as new (length: number) => T)(n);
	out.set(a);
	return out;
}

/**
 * Incremental BM25 index kept in packed typed arrays instead of nested Maps
 * (about 8 bytes per posting plus a little per term, instead of about 49 per
 * posting; the results are the same ids, scores and order as the Map-based
 * index this replaces).
 *
 * Chunk ids are interned to integers ("document numbers", handed out in the
 * order of adding, not reused until a compaction). The postings of every term
 * (document number, term frequency) live in one shared Uint32Array, each term
 * in a block whose capacity is a power of two; a full block moves to the next
 * size and its old block goes on a free list for the next term that needs it.
 * Removing a document only marks it dead (a tombstone: it costs nothing and
 * its postings are skipped); when the dead reach a quarter of the live
 * documents, a compaction renumbers the live ones, drops the dead postings
 * and terms and packs the blocks.
 */
export class Bm25 {
	private readonly numById = new Map<string, number>();
	// Per document number.
	private ids: (string | undefined)[] = [];
	private lengths = new Uint32Array(0);
	private alive = new Uint8Array(0);
	private numbers = 0; // handed out: live plus dead
	private live = 0;
	private totalLength = 0;
	// Per term number: where its block starts in `heap`, its size class (room for
	// 2 ** class postings), how many postings were written (dead ones included).
	private readonly termNumbers = new Map<string, number>();
	private termNames: (string | undefined)[] = [];
	private offset = new Uint32Array(0);
	private sizeClass = new Uint8Array(0);
	private used = new Uint32Array(0);
	private freeTerms: number[] = [];
	// The shared posting heap: pairs of (document number, term frequency).
	private heap = new Uint32Array(0);
	private top = 0;
	private readonly freeBlocks: number[][] = [];
	// Scratch for search: scores per document number, valid where stamp === generation.
	private scores = new Float64Array(0);
	private stamp = new Uint32Array(0);
	private generation = 0;
	private compactionCount = 0;

	constructor(
		private readonly k1 = 1.2,
		private readonly b = 0.75,
	) {}

	get size(): number {
		return this.live;
	}

	/** How many compactions ran (for tests: they must cover that path). */
	get compactions(): number {
		return this.compactionCount;
	}

	add(id: string, tokens: readonly string[]): void {
		this.remove(id);
		const tf = new Map<string, number>();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

		const num = this.numbers++;
		this.lengths = grown(this.lengths, this.numbers);
		this.alive = grown(this.alive, this.numbers);
		this.ids[num] = id;
		this.numById.set(id, num);
		this.lengths[num] = tokens.length;
		this.alive[num] = 1;
		for (const [term, n] of tf) {
			const t = this.termNumbers.get(term) ?? this.newTerm(term);
			const u = this.used[t]!;
			let at = this.offset[t]!;
			if (u === 2 ** this.sizeClass[t]!) {
				const moved = this.allocate(this.sizeClass[t]! + 1);
				this.heap.copyWithin(moved, at, at + 2 * u);
				this.release(at, this.sizeClass[t]!);
				this.offset[t] = at = moved;
				this.sizeClass[t] = this.sizeClass[t]! + 1;
			}
			this.heap[at + 2 * u] = num;
			this.heap[at + 2 * u + 1] = n;
			this.used[t] = u + 1;
		}
		this.live++;
		this.totalLength += tokens.length;
	}

	remove(id: string): void {
		const num = this.numById.get(id);
		if (num === undefined) return;
		this.numById.delete(id);
		this.ids[num] = undefined;
		this.alive[num] = 0;
		this.live--;
		this.totalLength -= this.lengths[num]!;
		const dead = this.numbers - this.live;
		if (dead >= 64 && dead * 4 >= this.live) this.compact();
	}

	/** Matching ids best first (score > 0), ties by id. The scratch arrays are per
	 *  instance, so `allow` must not call `search` on the same index. */
	search(query: readonly string[], allow?: (id: string) => boolean): { id: string; score: number }[] {
		const n = this.live;
		if (n === 0) return [];
		const avg = this.totalLength / n || 1;
		const { k1, b, alive, lengths, ids, heap } = this;
		const tombstones = this.numbers > n;
		if (this.scores.length < this.numbers) {
			this.scores = new Float64Array(this.lengths.length);
			this.stamp = new Uint32Array(this.lengths.length);
			this.generation = 0;
		}
		const { scores, stamp } = this;
		if (++this.generation === 0xffffffff) {
			stamp.fill(0);
			this.generation = 1;
		}
		const gen = this.generation;
		const touched: number[] = [];
		for (const term of new Set(query)) {
			const t = this.termNumbers.get(term);
			if (t === undefined) continue;
			const from = this.offset[t]!;
			const end = from + 2 * this.used[t]!;
			let df = this.used[t]!;
			if (tombstones) {
				df = 0;
				for (let i = from; i < end; i += 2) df += alive[heap[i]!]!;
				if (df === 0) continue;
			}
			const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
			for (let i = from; i < end; i += 2) {
				const num = heap[i]!;
				if (alive[num] === 0) continue;
				if (allow && !allow(ids[num]!)) continue;
				const tf = heap[i + 1]!;
				const len = lengths[num]!;
				const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avg));
				if (stamp[num] === gen) {
					scores[num] = scores[num]! + s;
				} else {
					stamp[num] = gen;
					scores[num] = s;
					touched.push(num);
				}
			}
		}
		const out: { id: string; score: number }[] = [];
		for (const num of touched) {
			const score = scores[num]!;
			if (score > 0) out.push({ id: ids[num]!, score });
		}
		return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
	}

	private newTerm(term: string): number {
		let t = this.freeTerms.pop();
		if (t === undefined) {
			t = this.termNames.length;
			this.termNames.push(undefined);
			this.offset = grown(this.offset, t + 1);
			this.sizeClass = grown(this.sizeClass, t + 1);
			this.used = grown(this.used, t + 1);
		}
		this.termNames[t] = term;
		this.offset[t] = this.allocate(0);
		this.sizeClass[t] = 0;
		this.used[t] = 0;
		this.termNumbers.set(term, t);
		return t;
	}

	/** A block with room for 2 ** sizeClass postings: a freed one, else new heap. */
	private allocate(sizeClass: number): number {
		const reused = this.freeBlocks[sizeClass]?.pop();
		if (reused !== undefined) return reused;
		const size = 2 * 2 ** sizeClass;
		if (this.top + size > this.heap.length) {
			const bigger = new Uint32Array(Math.max(this.top + size, Math.ceil(this.heap.length * 1.5), 1024));
			bigger.set(this.heap.subarray(0, this.top));
			this.heap = bigger;
		}
		const at = this.top;
		this.top += size;
		return at;
	}

	private release(at: number, sizeClass: number): void {
		(this.freeBlocks[sizeClass] ??= []).push(at);
	}

	/** Renumber the live documents densely, drop dead postings and terms with no
	 *  live posting left, and slide the blocks together (in place: nothing moves up). */
	private compact(): void {
		this.compactionCount++;
		const remap = new Int32Array(this.numbers).fill(-1);
		let next = 0;
		for (let num = 0; num < this.numbers; num++) {
			if (this.alive[num] === 0) continue;
			const id = this.ids[num]!;
			this.ids[next] = id;
			this.lengths[next] = this.lengths[num]!;
			this.numById.set(id, next);
			remap[num] = next++;
		}
		this.ids.length = next;
		this.alive.fill(1, 0, next);
		this.alive.fill(0, next);
		this.numbers = next;

		const order: number[] = [];
		for (let t = 0; t < this.termNames.length; t++) if (this.termNames[t] !== undefined) order.push(t);
		order.sort((x, y) => this.offset[x]! - this.offset[y]!);
		const heap = this.heap;
		let dst = 0;
		for (const t of order) {
			const src = this.offset[t]!;
			let w = 0;
			for (let r = 0; r < this.used[t]!; r++) {
				const to = remap[heap[src + 2 * r]!]!;
				if (to < 0) continue;
				heap[dst + 2 * w] = to;
				heap[dst + 2 * w + 1] = heap[src + 2 * r + 1]!;
				w++;
			}
			if (w === 0) {
				this.termNumbers.delete(this.termNames[t]!);
				this.termNames[t] = undefined;
				this.used[t] = 0;
				this.freeTerms.push(t);
				continue;
			}
			const sizeClass = 32 - Math.clz32(w - 1);
			this.offset[t] = dst;
			this.sizeClass[t] = sizeClass;
			this.used[t] = w;
			dst += 2 * 2 ** sizeClass;
		}
		this.top = dst;
		this.freeBlocks.length = 0;
		if (this.heap.length > dst * 1.5 + 1024) this.heap = this.heap.slice(0, Math.ceil(dst * 1.25));
	}
}

// ─── vectors and fusion ──────────────────────────────────────────────────────

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i]!;
		const y = b[i]!;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Reciprocal Rank Fusion over best-first id lists (k 60). Ties keep the
 *  order of first appearance, so the result is deterministic. */
export function rrf(rankings: readonly (readonly string[])[], k = 60): { id: string; score: number }[] {
	const scores = new Map<string, number>();
	for (const ranking of rankings) {
		ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
	}
	return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

// ─── chunking ────────────────────────────────────────────────────────────────

export const CHUNK_CHARS = 1200;

const PAGE_LINE = /^[ \t]*<!--\s*page\s+(\d+)\s*-->[ \t]*$/gim;

interface PageMarker {
	index: number;
	end: number;
	page: number;
}

function pageMarkers(markdown: string): PageMarker[] {
	const out: PageMarker[] = [];
	for (const m of markdown.matchAll(PAGE_LINE)) {
		out.push({ index: m.index, end: m.index + m[0].length, page: Number(m[1]) });
	}
	return out;
}

/** A retrieval unit: a stretch of one section. */
export interface ChunkUnit {
	sectionId: string;
	headingPath: string[];
	pageFrom?: number;
	pageTo?: number;
	start: number;
	end: number;
	/** The unit's text without page-marker lines. */
	text: string;
}

export function stripPageMarkers(text: string): string {
	return text.replace(PAGE_LINE, "").replace(/\n{3,}/g, "\n\n");
}

/** Cut points inside [s, e) so no piece exceeds `max`: newline, else a
 *  sentence end, else a space, else a hard cut. */
function hardSplit(md: string, s: number, e: number, max: number): [number, number][] {
	const out: [number, number][] = [];
	while (e - s > max) {
		const window = md.slice(s, s + max);
		const floor = Math.floor(max * 0.5);
		let cut = window.lastIndexOf("\n");
		if (cut < floor) cut = window.lastIndexOf(". ") + 1;
		if (cut < floor) cut = window.lastIndexOf(" ");
		if (cut < floor) cut = max;
		out.push([s, s + cut]);
		s += cut;
	}
	if (md.slice(s, e).trim() !== "") out.push([s, e]);
	return out;
}

/** Sections -> retrieval units. A unit never crosses a section. */
export function chunkDocument(markdown: string, sections: readonly DocumentSection[], max = CHUNK_CHARS): ChunkUnit[] {
	const markers = pageMarkers(markdown);
	const hasPages = markers.length > 0;
	const units: ChunkUnit[] = [];

	for (const section of sections) {
		const pageAt = (pos: number): number | undefined => {
			let page = section.pageFrom;
			for (const m of markers) {
				if (m.end > pos) break;
				if (m.end > section.start) page = m.page;
			}
			return page;
		};
		/** First/last content position of [s, e), skipping whitespace and marker lines. */
		const contentSpan = (s: number, e: number): [number, number] | null => {
			let a = s;
			for (;;) {
				while (a < e && /\s/.test(markdown[a]!)) a++;
				const m = markers.find((x) => a >= x.index && a < x.end);
				if (!m) break;
				a = m.end;
			}
			let z = e;
			for (;;) {
				while (z > a && /\s/.test(markdown[z - 1]!)) z--;
				const m = markers.find((x) => z - 1 >= x.index && z - 1 < x.end);
				if (!m) break;
				z = m.index;
			}
			return a < z ? [a, z] : null;
		};
		const push = (s: number, e: number) => {
			const span = contentSpan(s, e);
			if (!span) return;
			const text = stripPageMarkers(markdown.slice(s, e)).trim();
			if (text === "") return;
			const pageFrom = hasPages ? pageAt(span[0]) : undefined;
			const pageTo = hasPages ? pageAt(span[1] - 1) : undefined;
			units.push({
				sectionId: section.id,
				headingPath: section.headingPath,
				...(pageFrom !== undefined ? { pageFrom, pageTo: pageTo ?? pageFrom } : {}),
				start: s,
				end: e,
				text,
			});
		};

		// Paragraphs of the section, then greedy packing up to `max`.
		const paragraphs: [number, number][] = [];
		let from = section.start;
		for (const sep of markdown.slice(section.start, section.end).matchAll(/(?:\r?\n[ \t]*){2,}/g)) {
			const at = section.start + sep.index;
			if (at > from) paragraphs.push([from, at]);
			from = at + sep[0].length;
		}
		if (section.end > from) paragraphs.push([from, section.end]);

		let cur: [number, number] | null = null;
		for (const [s, e] of paragraphs) {
			if (e - s > max) {
				if (cur) push(cur[0], cur[1]);
				cur = null;
				for (const [ps, pe] of hardSplit(markdown, s, e, max)) push(ps, pe);
			} else if (cur && e - cur[0] <= max) {
				cur[1] = e;
			} else {
				if (cur) push(cur[0], cur[1]);
				cur = [s, e];
			}
		}
		if (cur) push(cur[0], cur[1]);
	}
	return units;
}

/** What BM25 indexes for a unit: the heading path (so titles count) + text. */
export function indexText(unit: Pick<ChunkUnit, "headingPath" | "text">): string {
	return `${unit.headingPath.join(" ")}\n${unit.text}`;
}

// ─── snippets ────────────────────────────────────────────────────────────────

const SNIPPET_CHARS = 300;

/** Plain text of about 300 chars around the densest cluster of query terms
 *  (the unit's start when nothing matches). */
export function snippetAround(text: string, queryTokens: readonly string[], size = SNIPPET_CHARS): string {
	const flat = stripPageMarkers(text)
		.replace(/^#{1,6}[ \t]+/gm, "")
		.replace(/[*_`]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (flat.length <= size) return flat;
	const wanted = new Set(queryTokens);
	const matches: { at: number; term: string }[] = [];
	for (const m of flat.matchAll(/[\p{L}\p{N}][\p{L}\p{N}()^+#]*/gu)) {
		const hit = tokenize(m[0]).find((t) => wanted.has(t));
		if (hit) matches.push({ at: m.index, term: hit });
	}
	let start = 0;
	if (matches.length > 0) {
		let best = -1;
		for (const first of matches) {
			const lo = Math.max(0, first.at - 60);
			const terms = new Set(matches.filter((m) => m.at >= lo && m.at < lo + size).map((m) => m.term));
			if (terms.size > best) {
				best = terms.size;
				start = lo;
			}
		}
	}
	let end = Math.min(flat.length, start + size);
	if (start > 0) start = Math.max(flat.indexOf(" ", start) + 1, start);
	if (end < flat.length) {
		const space = flat.lastIndexOf(" ", end);
		if (space > start + size / 2) end = space;
	}
	return `${start > 0 ? "… " : ""}${flat.slice(start, end).trim()}${end < flat.length ? " …" : ""}`;
}

// ─── filters ─────────────────────────────────────────────────────────────────

/** A topic filter matches a document topic by folded equality or containment. */
export function topicMatches(topics: readonly string[], wanted: string): boolean {
	const w = foldKey(wanted);
	if (w === "") return true;
	return topics.some((t) => {
		const k = foldKey(t);
		return k === w || k.includes(w) || w.includes(k);
	});
}

/** A document reference is a docId or (part of) a title. */
export function documentMatches(doc: { id: string; title: string }, ref: string): boolean {
	const r = ref.trim();
	if (r === "") return true;
	if (doc.id === r) return true;
	const k = foldKey(r);
	return k !== "" && foldKey(doc.title).includes(k);
}

// ─── reading ─────────────────────────────────────────────────────────────────

export const READ_CAP = 12_000;

interface SliceDoc {
	id: string;
	title: string;
	pages?: number;
	sections: readonly DocumentSection[];
}

const pageSpan = (a?: number, b?: number) => (a === undefined ? "" : b === undefined || a === b ? `p.${a}` : `p.${a}-${b}`);

function parsePages(spec: string): [number, number] | null {
	const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(spec);
	if (!m) return null;
	const a = Number(m[1]);
	const b = m[2] === undefined ? a : Number(m[2]);
	return a <= b ? [a, b] : [b, a];
}

function outline(doc: SliceDoc): string {
	const lines = doc.sections.map((s) => {
		const path = s.headingPath.length > 0 ? s.headingPath.join(" > ") : "(untitled)";
		const pages = pageSpan(s.pageFrom, s.pageTo);
		return `${s.id} · ${path}${pages ? ` · ${pages}` : ""} · ${s.end - s.start} chars`;
	});
	return lines.join("\n");
}

/**
 * The exact stored text of a section or page range, capped at READ_CAP
 * chars from `offset` (the result says where to continue). With neither
 * selector: the section outline. Page markers stay in the text; a section
 * that starts mid-page gets its page marker prepended.
 */
export function sliceDocument(
	doc: SliceDoc,
	markdown: string,
	query: DocReadQuery = {},
	cap = READ_CAP,
): DocReadResult {
	const base = { ok: true as const, docId: doc.id, title: doc.title };
	if (query.section !== undefined && query.pages !== undefined) {
		return { ok: false, error: "Give either section or pages, not both." };
	}
	if (query.section === undefined && query.pages === undefined) {
		return { ...base, kind: "outline", label: "outline", text: outline(doc), truncated: false };
	}

	let selection: string;
	let label: string;
	let extra: Partial<DocReadResult & { ok: true }> = {};
	if (query.section !== undefined) {
		const wanted = query.section.trim().toLowerCase();
		const section = doc.sections.find((s) => s.id === wanted) ?? doc.sections.find((s) => s.id === `s${wanted}`);
		if (!section) {
			return { ok: false, error: `No section "${query.section}" in this document. Sections:\n${outline(doc)}` };
		}
		const body = markdown.slice(section.start, section.end);
		selection =
			section.pageFrom !== undefined && !/^[ \t]*<!--\s*page\s/i.test(body)
				? `<!-- page ${section.pageFrom} -->\n${body}`
				: body;
		label = `§ ${section.headingPath.length > 0 ? section.headingPath.join(" > ") : section.id}`;
		extra = { sectionId: section.id, headingPath: section.headingPath, pageFrom: section.pageFrom, pageTo: section.pageTo };
	} else {
		const range = parsePages(query.pages ?? "");
		if (!range) return { ok: false, error: `pages must look like "4" or "3-5", got "${query.pages}".` };
		const markers = pageMarkers(markdown);
		if (markers.length === 0) {
			return { ok: false, error: "This document has no page markers; read it by section instead." };
		}
		const inRange = markers.filter((m) => m.page >= range[0] && m.page <= range[1]);
		const first = inRange[0];
		const last = inRange[inRange.length - 1];
		if (!first || !last) {
			const nums = markers.map((m) => m.page);
			return { ok: false, error: `No pages ${range[0]}-${range[1]} here; this document has pages ${Math.min(...nums)}-${Math.max(...nums)}.` };
		}
		const next = markers.find((m) => m.index > last.index);
		selection = markdown.slice(first.index, next ? next.index : markdown.length);
		label = `pages ${first.page === last.page ? first.page : `${first.page}-${last.page}`}`;
		extra = { pageFrom: first.page, pageTo: last.page };
	}

	const offset = Math.max(0, Math.floor(query.offset ?? 0));
	if (offset >= selection.length && selection.length > 0) {
		return { ok: false, error: `offset ${offset} is past the end (${selection.length} chars).` };
	}
	let end = Math.min(selection.length, offset + cap);
	if (end < selection.length) {
		const nl = selection.lastIndexOf("\n", end);
		if (nl > offset + cap * 0.6) end = nl + 1;
	}
	const truncated = end < selection.length;
	return {
		...base,
		kind: "slice",
		label,
		text: selection.slice(offset, end),
		truncated,
		...(truncated ? { nextOffset: end } : {}),
		...extra,
	};
}
