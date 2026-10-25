/**
 * Page splitting for the document reader (browser-safe, no node builtins):
 * the stored markdown carries `<!-- page N -->` markers (the OCR sidecar's
 * output); the reader renders one block per page so each gets a #p-N anchor.
 */

export interface DocumentPage {
	/** The page number, or null for text before the first marker (or the
	 *  whole text of a document without markers). */
	page: number | null;
	markdown: string;
}

/** Drop a leading `---` front matter block. */
export function stripFrontMatter(markdown: string): string {
	const m = /^---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m.exec(markdown);
	return m && m.index === 0 ? markdown.slice(m[0].length) : markdown;
}

/** Split into pages at the markers; empty chunks are dropped. */
export function splitPages(markdown: string): DocumentPage[] {
	const body = stripFrontMatter(markdown);
	const out: DocumentPage[] = [];
	const marker = /^[ \t]*<!--\s*page\s+(\d+)\s*-->[ \t]*$/gim;
	let page: number | null = null;
	let from = 0;
	const push = (end: number) => {
		const chunk = body.slice(from, end).trim();
		if (chunk !== "") out.push({ page, markdown: chunk });
	};
	for (let m = marker.exec(body); m; m = marker.exec(body)) {
		push(m.index);
		page = Number(m[1]);
		from = m.index + m[0].length;
	}
	push(body.length);
	return out;
}
