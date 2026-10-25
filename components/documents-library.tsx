"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { FileTextIcon, SearchIcon, UploadIcon } from "lucide-react";
import type { DocumentSummary } from "@/src/core";
import { AddDocumentsDialog } from "@/components/add-documents-dialog";
import { useServerEvent } from "@/components/server-events";
import { TopBar } from "@/components/top-bar";

/**
 * THE DOCUMENT LIBRARY (/documents): every imported document - title,
 * topic chips, pages, date, origin, with the filenames it arrived under as
 * small aliases (the filename is never the identity). A row opens the
 * reader (/documents/[id]); Add documents opens the same dialog as the
 * graph's button. Mobile first: one column, nothing wider than the screen.
 */

/** Case-insensitive match over title, topics, summary and filename aliases. */
export function matchesQuery(doc: DocumentSummary, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q === "") return true;
	return [doc.title, doc.summary, ...doc.topics, ...doc.filenames].some((s) => s.toLowerCase().includes(q));
}

/** ISO date (UTC): identical on the server and the client render. */
const day = (iso: string) => iso.slice(0, 10);

export function DocumentsLibraryBody({
	documents,
	query,
	onQuery,
	onAdd,
}: {
	documents: DocumentSummary[];
	query: string;
	onQuery: (q: string) => void;
	onAdd: () => void;
}) {
	const shown = documents.filter((d) => matchesQuery(d, query));
	return (
		<div data-testid="documents-library" className="flex h-full min-h-0 flex-col">
			<TopBar>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{documents.length} {documents.length === 1 ? "document" : "documents"}
				</span>
				<div className="relative min-w-0 max-w-56 flex-1 sm:w-auto sm:flex-none sm:shrink-0">
					<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						value={query}
						onChange={(e) => onQuery(e.target.value)}
						placeholder="Search…"
						aria-label="Search documents"
						spellCheck={false}
						className="h-8 w-full rounded-lg border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-ring sm:w-56"
					/>
				</div>
				<button
					type="button"
					onClick={onAdd}
					data-testid="library-add-documents"
					aria-label="Add documents"
					className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-card/80 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-sm:w-8 max-sm:px-0"
				>
					<UploadIcon className="size-3.5" />
					<span className="hidden sm:inline">Add documents…</span>
				</button>
			</TopBar>

			<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 pb-safe sm:px-6">
				{documents.length === 0 ? (
					<p data-testid="documents-empty" className="mx-auto max-w-md px-2 py-16 text-center text-sm text-muted-foreground">
						No documents yet. Add markdown notes or scanned PDFs and they will be listed here, readable and searchable, and feed the knowledge graph.
					</p>
				) : shown.length === 0 ? (
					<p className="px-2 py-8 text-center text-sm text-muted-foreground">No documents match.</p>
				) : (
					<ul className="mx-auto flex max-w-3xl flex-col gap-2.5">
						{shown.map((doc) => (
							<li key={doc.id}>
								<Link
									href={`/documents/${doc.id}`}
									data-testid="document-row"
									className="block min-w-0 rounded-lg border border-border/70 bg-card/60 px-4 py-3 transition-colors hover:bg-accent pointer-coarse:min-h-11"
								>
									<div className="flex min-w-0 items-start gap-2.5">
										<FileTextIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<div className="break-words font-medium text-foreground">{doc.title}</div>
											<div className="mt-0.5 text-xs text-muted-foreground">
												{doc.origin === "pdf" ? "Scanned PDF" : "Markdown"}
												{doc.pages ? ` · ${doc.pages} pages` : ""} · {day(doc.importedAt)}
											</div>
											{doc.topics.length > 0 && (
												<div className="mt-2 flex flex-wrap gap-1.5">
													{doc.topics.map((t) => (
														<span key={t} className="max-w-full break-words rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
															{t}
														</span>
													))}
												</div>
											)}
											{doc.filenames.length > 0 && (
												<div data-testid="document-aliases" className="mt-1.5 break-words text-[11px] text-muted-foreground/70">
													{doc.filenames.join(" · ")}
												</div>
											)}
										</div>
									</div>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

export function DocumentsLibrary({ initial }: { initial: DocumentSummary[] }) {
	const [documents, setDocuments] = useState(initial);
	const [query, setQuery] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const refetch = useCallback(() => {
		fetch("/api/documents")
			.then((res) => res.json() as Promise<{ documents: DocumentSummary[] }>)
			.then((body) => setDocuments(body.documents))
			.catch(() => {});
	}, []);
	// A scan or extraction ending changes the library; the events channel announces it.
	useServerEvent("activity-changed", refetch);
	return (
		<>
			<DocumentsLibraryBody documents={documents} query={query} onQuery={setQuery} onAdd={() => setAddOpen(true)} />
			<AddDocumentsDialog open={addOpen} onClose={() => setAddOpen(false)} onImported={refetch} />
		</>
	);
}
