/**
 * Section-aware chunking for stored documents (PR H) - pure.
 *
 * A stored document arrives with its parsed `sections` (core/documents.ts
 * parseSections: heading chain, page range, char offsets). The extractor
 * should read it the way the document is organised, not as an arbitrary run
 * of lines, so chunks are built from WHOLE sections:
 *
 *   - greedy fill: sections join the current chunk while it stays within
 *     the token budget;
 *   - a section larger than the budget is split by paragraphs (then lines);
 *     its pieces keep the section's id;
 *   - a chunk never spans two top-level headings (headingPath[0]): a new
 *     chapter always starts a new chunk, however small the last one was.
 *
 * Each chunk carries the header the extractor sees: the document TITLE,
 * the heading path and pages, the document's TOPICS, and the section ids it
 * may cite. The FILENAME is never part of it (identity and description are
 * content-derived end to end). The text the extractor reads has the
 * `<!-- page N -->` markers and the OCR page-image lines stripped - page
 * numbers reach it only through the header.
 */

import type { DocumentSection } from "../../core/contracts/documents.ts";

/** chars/4, like every other estimate in the app. */
const tokens = (s: string): number => Math.ceil(s.length / 4);

const PAGE_MARKER_LINE = /^[ \t]*<!--\s*page\s+\d+\s*-->[ \t]*\r?\n?/gim;
const PAGE_IMAGE_LINE = /^[ \t]*!\[page \d+\]\([^)]*\)[ \t]*\r?\n?/gim;

/** What the extractor reads of a section: no page markers, no page images. */
export function readableText(raw: string): string {
	return raw.replace(PAGE_MARKER_LINE, "").replace(PAGE_IMAGE_LINE, "").trim();
}

/** One section as the chunk records it (pages feed the provenance stamp). */
export interface ChunkSection {
	id: string;
	headingPath: string[];
	pageFrom?: number;
	pageTo?: number;
}

export interface DocumentChunk {
	/** The sections (or section pieces) this chunk reads, in order. */
	sections: ChunkSection[];
	/** The readable text, each section introduced by a `[section sN]` line. */
	body: string;
	/** Pieces of one oversize section are marked (i of n) in the header. */
	piece?: { i: number; n: number };
}

interface Piece {
	section: ChunkSection;
	text: string;
	/** Set on the pieces of a split section. */
	split?: { i: number; n: number };
}

const labelOf = (s: ChunkSection): string => (s.headingPath.length > 0 ? s.headingPath.join(" › ") : "(before the first heading)");

/** Paragraph-then-line split of one oversize text into pieces <= budget
 *  tokens (a single over-budget line rides alone - never cut a line). */
function splitOversize(text: string, budget: number): string[] {
	const units: string[] = [];
	for (const paragraph of text.split(/\n[ \t]*\n/)) {
		if (tokens(paragraph) <= budget) units.push(paragraph);
		else units.push(...paragraph.split("\n"));
	}
	const out: string[] = [];
	let current = "";
	for (const unit of units) {
		const joined = current === "" ? unit : `${current}\n${unit}`;
		if (current !== "" && tokens(joined) > budget) {
			out.push(current);
			current = unit;
		} else current = joined;
	}
	if (current.trim() !== "") out.push(current);
	return out;
}

export function chunkDocument(text: string, sections: readonly DocumentSection[], budgetTokens: number): DocumentChunk[] {
	const pieces: Piece[] = [];
	for (const s of sections) {
		const body = readableText(text.slice(s.start, s.end));
		if (body === "") continue;
		const section: ChunkSection = {
			id: s.id,
			headingPath: s.headingPath,
			...(s.pageFrom !== undefined ? { pageFrom: s.pageFrom } : {}),
			...(s.pageTo !== undefined ? { pageTo: s.pageTo } : {}),
		};
		if (tokens(body) <= budgetTokens) {
			pieces.push({ section, text: body });
			continue;
		}
		const parts = splitOversize(body, budgetTokens);
		parts.forEach((part, i) => pieces.push({ section, text: part, split: { i: i + 1, n: parts.length } }));
	}

	const chunks: DocumentChunk[] = [];
	let current: Piece[] = [];
	const flush = () => {
		if (current.length === 0) return;
		const first = current[0]!;
		chunks.push({
			sections: current.map((p) => p.section),
			body: current.map((p) => `[section ${p.section.id}]\n${p.text}`).join("\n\n"),
			...(current.length === 1 && first.split ? { piece: first.split } : {}),
		});
		current = [];
	};
	const sizeOf = (ps: readonly Piece[]) => tokens(ps.map((p) => `[section ${p.section.id}]\n${p.text}`).join("\n\n"));
	const top = (p: Piece) => p.section.headingPath[0] ?? "";
	for (const piece of pieces) {
		const last = current[current.length - 1];
		if (last && (top(last) !== top(piece) || last.split !== undefined || piece.split !== undefined || sizeOf([...current, piece]) > budgetTokens)) {
			flush();
		}
		current.push(piece);
	}
	flush();
	return chunks;
}

// ─── the header the extractor sees ───────────────────────────────────────────

function pagesOf(sections: readonly ChunkSection[]): string {
	const from = sections.flatMap((s) => (s.pageFrom !== undefined ? [s.pageFrom] : []));
	const to = sections.flatMap((s) => (s.pageTo !== undefined ? [s.pageTo] : s.pageFrom !== undefined ? [s.pageFrom] : []));
	if (from.length === 0) return "";
	const lo = Math.min(...from);
	const hi = Math.max(...to);
	return lo === hi ? `p. ${lo}` : `pp. ${lo}–${hi}`;
}

/** "§ 2 Kontextwechsel › 2.1 Register (pp. 3–4)" - one section, or the span
 *  from the first to the last section of the chunk. */
export function locationLabel(chunk: DocumentChunk): string {
	const first = chunk.sections[0]!;
	const last = chunk.sections[chunk.sections.length - 1]!;
	const where = chunk.sections.length === 1 || labelOf(first) === labelOf(last) ? labelOf(first) : `${labelOf(first)} … ${labelOf(last)}`;
	const pages = pagesOf(chunk.sections);
	const piece = chunk.piece ? `, part ${chunk.piece.i}/${chunk.piece.n}` : "";
	return `§ ${where}${pages !== "" || piece !== "" ? ` (${[pages, piece.replace(/^, /, "")].filter((x) => x !== "").join(", ")})` : ""}`;
}

/** The whole view of one chunk: header, topics, citable section ids, text.
 *  `part` is this chunk's place among the document's chunks. */
export function documentChunkView(
	doc: { title: string; topics: readonly string[] },
	chunk: DocumentChunk,
	part?: { i: number; n: number },
): string {
	const ids = [...new Map(chunk.sections.map((s) => [s.id, s])).values()]
		.map((s) => `${s.id} = ${labelOf(s)}${pagesOf([s]) !== "" ? ` (${pagesOf([s])})` : ""}`)
		.join("; ");
	return [
		`DOCUMENT: ${doc.title} — ${locationLabel(chunk)}${part && part.n > 1 ? ` [stretch ${part.i}/${part.n}]` : ""}`,
		`THE DOCUMENT'S TOPICS: ${doc.topics.length > 0 ? doc.topics.join("; ") : "(none listed)"}`,
		`SECTIONS IN THIS STRETCH (cite these ids): ${ids}`,
		"",
		chunk.body,
	].join("\n");
}
