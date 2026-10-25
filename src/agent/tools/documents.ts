import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { DocSearchQuery, DocSearchResult } from "../../core/doc-search.ts";

/**
 * THE DOCUMENT SEARCH TOOL: `search_documents` finds passages of the learner's
 * imported documents and the concepts of his knowledge graph (keyword and
 * semantic, merged), and names the library file each hit lives in. Reading
 * is the library tools' job (`ls`, `find`, `grep`, `read`, rooted at the
 * library); `read_document` and `list_documents` are retired - old
 * transcripts keep rendering them (components/artifacts/document-card.tsx).
 * Registered on the prober, teacher and practice agents when the
 * agent.documentTools gate is open (documentToolsEnabled); the composition
 * root passes the function in (the tools/graph.ts idiom - the agent layer
 * never imports server/store), and an absent `deps` means the gate is
 * closed: no tool.
 *
 * The result carries the model's text AND a compact `details` record the
 * transcript card renders from: ids, titles, paths and page numbers, never
 * the document text.
 */

export interface DocumentToolDeps {
	search(input: DocSearchQuery & { query: string }): Promise<DocSearchResult>;
}

/** What a search result's `details` holds (the card's whole input). */
export interface DocumentToolDetails {
	kind: "search";
	query: string;
	mode: "hybrid" | "keyword";
	note?: string;
	hits: {
		kind: "section" | "concept";
		path: string;
		docId: string;
		conceptId?: string;
		title: string;
		sectionId: string;
		headingPath: string[];
		pageFrom?: number;
		pageTo?: number;
		snippet: string;
	}[];
}

const searchInput = Type.Object({
	query: Type.String({ minLength: 1, description: "What to look for, in the learner's words or the document's" }),
	topic: Type.Optional(Type.String({ minLength: 1, description: "Only material on this topic (a topic as the library's topics/ files name it)" })),
	document: Type.Optional(Type.String({ minLength: 1, description: "Only this document: its docId or part of its title" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Hits to return (default 8)" })),
});

const pageLabel = (from?: number, to?: number) =>
	from === undefined ? "" : to === undefined || to === from ? `p.${from}` : `p.${from}-${to}`;

export function documentTools(deps: DocumentToolDeps): Record<string, AgentTool<any>> {
	return {
		search_documents: {
			name: "search_documents",
			label: "search_documents",
			description:
				"Search the library when you do not know where something is (keyword and semantic, merged). Hits are passages of the learner's documents (title, section, pages) and concepts of his knowledge graph; each names its file in the library, which you open with read. " +
				"topic and document narrow the search; a document filter keeps only the concepts that came from that document. The result says when it is keyword-only.",
			parameters: searchInput,
			execute: serverExecute("search_documents", searchInput, async (input): Promise<unknown> => {
				const result = await deps.search(input);
				const header = `${result.hits.length} hit(s) for "${result.query}" (${result.mode === "hybrid" ? "keyword + semantic" : "keyword only"})${result.note ? ` - ${result.note}` : ""}`;
				const lines = result.hits.map((h, i) => {
					if (h.kind === "concept") return `${i + 1}. Concept · ${h.title}\n   ${h.path}\n   ${h.snippet}`;
					const where = [h.headingPath.length > 0 ? `§ ${h.headingPath.join(" > ")}` : "", pageLabel(h.pageFrom, h.pageTo)].filter(Boolean).join(" · ");
					return `${i + 1}. ${h.title}${where ? ` · ${where}` : ""}\n   ${h.path}\n   ${h.snippet}`;
				});
				const details: DocumentToolDetails = {
					kind: "search",
					query: result.query,
					mode: result.mode,
					...(result.note ? { note: result.note } : {}),
					hits: result.hits.map(({ kind, path, docId, conceptId, title, sectionId, headingPath, pageFrom, pageTo, snippet }) => ({
						kind,
						path,
						docId,
						...(conceptId !== undefined ? { conceptId } : {}),
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
	};
}
