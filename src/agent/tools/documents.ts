import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type {
	DocListEntry,
	DocReadQuery,
	DocReadResult,
	DocSearchQuery,
	DocSearchResult,
} from "../../core/doc-search.ts";

/**
 * THE DOCUMENT TOOLS (PR I): the learner's imported library (notes, scanned
 * sheets) as something the agents can consult - search it, read exact text
 * with page markers, list what exists. Registered on the prober, teacher and
 * practice agents when the agent.documentTools gate is open
 * (documentToolsEnabled); the composition root passes the three functions in
 * (the tools/graph.ts idiom - the agent layer never imports server/store),
 * and an absent `deps` means the gate is closed: no tools.
 *
 * Tool results carry the model's text AND a compact `details` record the
 * transcript card renders from (components/artifacts/document-card.tsx):
 * ids, titles and page numbers, never the document text.
 */

export interface DocumentToolDeps {
	search(input: DocSearchQuery & { query: string }): Promise<DocSearchResult>;
	read(input: { document: string } & DocReadQuery): DocReadResult;
	list(input: { topic?: string }): DocListEntry[];
}

/** What a document tool result's `details` holds (the card's whole input). */
export type DocumentToolDetails =
	| {
			kind: "search";
			query: string;
			mode: "hybrid" | "keyword";
			note?: string;
			hits: { docId: string; title: string; sectionId: string; headingPath: string[]; pageFrom?: number; pageTo?: number; snippet: string }[];
	  }
	| {
			kind: "read";
			ok: boolean;
			error?: string;
			docId?: string;
			title?: string;
			label?: string;
			sectionId?: string;
			pageFrom?: number;
			pageTo?: number;
			truncated?: boolean;
	  }
	| { kind: "list"; topic?: string; count: number };

const searchInput = Type.Object({
	query: Type.String({ minLength: 1, description: "What to look for, in the learner's words or the document's" }),
	topic: Type.Optional(Type.String({ minLength: 1, description: "Only documents tagged with this topic (as list_documents shows it)" })),
	document: Type.Optional(Type.String({ minLength: 1, description: "Only this document: its docId or part of its title" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Hits to return (default 8)" })),
});

const readInput = Type.Object({
	document: Type.String({ minLength: 1, description: "The document's docId, or part of its title" }),
	section: Type.Optional(Type.String({ minLength: 1, description: 'A section id such as "s4", from search_documents or the outline' })),
	pages: Type.Optional(Type.String({ minLength: 1, description: 'A page "4" or a range "3-5"' })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Continue a capped read at this character offset of the selection" })),
});

const listInput = Type.Object({
	topic: Type.Optional(Type.String({ minLength: 1, description: "Only documents tagged with this topic" })),
});

const pageLabel = (from?: number, to?: number) =>
	from === undefined ? "" : to === undefined || to === from ? `p.${from}` : `p.${from}-${to}`;

export function documentTools(deps: DocumentToolDeps): Record<string, AgentTool<any>> {
	return {
		search_documents: {
			name: "search_documents",
			label: "search_documents",
			description:
				"Search the learner's imported documents (keyword and semantic, merged). Returns ranked passages: document title, section path, pages, a snippet, and the ids to read them with. " +
				"topic and document narrow the search. The result says when it is keyword-only.",
			parameters: searchInput,
			execute: serverExecute("search_documents", searchInput, async (input): Promise<unknown> => {
				const result = await deps.search(input);
				const header = `${result.hits.length} hit(s) for "${result.query}" (${result.mode === "hybrid" ? "keyword + semantic" : "keyword only"})${result.note ? ` - ${result.note}` : ""}`;
				const lines = result.hits.map((h, i) => {
					const where = [h.headingPath.length > 0 ? `§ ${h.headingPath.join(" > ")}` : "", pageLabel(h.pageFrom, h.pageTo)].filter(Boolean).join(" · ");
					return `${i + 1}. ${h.title}${where ? ` · ${where}` : ""}\n   docId ${h.docId} · section ${h.sectionId}\n   ${h.snippet}`;
				});
				const details: DocumentToolDetails = {
					kind: "search",
					query: result.query,
					mode: result.mode,
					...(result.note ? { note: result.note } : {}),
					hits: result.hits.map(({ docId, title, sectionId, headingPath, pageFrom, pageTo, snippet }) => ({
						docId,
						title,
						sectionId,
						headingPath,
						...(pageFrom !== undefined ? { pageFrom, pageTo } : {}),
						snippet,
					})),
				};
				return { text: [header, ...lines].join("\n"), details };
			}),
		},
		read_document: {
			name: "read_document",
			label: "read_document",
			description:
				"Read the exact stored text of one document: a section (id from search_documents or the outline) or a page range. Page markers (<!-- page N -->) stay in the text. " +
				"With neither section nor pages it returns the section outline. A selection is capped at about 12000 characters; when capped, the result gives the offset to continue from.",
			parameters: readInput,
			execute: serverExecute("read_document", readInput, async (input): Promise<unknown> => {
				const result = deps.read(input);
				if (!result.ok) {
					const details: DocumentToolDetails = { kind: "read", ok: false, error: result.error };
					return { text: result.error, details };
				}
				const where = pageLabel(result.pageFrom, result.pageTo);
				const head = `${result.title} (${result.docId}) - ${result.label}${where && result.sectionId ? ` · ${where}` : ""}`;
				const tail = result.truncated
					? `\n---\n[Capped here. Continue the same read with offset=${result.nextOffset}.]`
					: "";
				const details: DocumentToolDetails = {
					kind: "read",
					ok: true,
					docId: result.docId,
					title: result.title,
					label: result.label,
					...(result.sectionId ? { sectionId: result.sectionId } : {}),
					...(result.pageFrom !== undefined ? { pageFrom: result.pageFrom, pageTo: result.pageTo } : {}),
					truncated: result.truncated,
				};
				return { text: `${head}\n---\n${result.text}${tail}`, details };
			}),
		},
		list_documents: {
			name: "list_documents",
			label: "list_documents",
			description: "List the learner's imported documents: title, topics, page count and docId. topic narrows the list.",
			parameters: listInput,
			execute: serverExecute("list_documents", listInput, async ({ topic }): Promise<unknown> => {
				const entries = deps.list({ topic });
				const details: DocumentToolDetails = { kind: "list", ...(topic ? { topic } : {}), count: entries.length };
				if (entries.length === 0) {
					return { text: topic ? `No documents tagged "${topic}".` : "The library has no documents yet.", details };
				}
				const lines = entries.map(
					(e) => `- ${e.title} · topics: ${e.topics.join(", ") || "none"}${e.pages !== undefined ? ` · ${e.pages} pages` : ""} · docId ${e.docId}`,
				);
				return { text: `${entries.length} document(s):\n${lines.join("\n")}`, details };
			}),
		},
	};
}
