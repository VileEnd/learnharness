"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import Link from "next/link";
import { FileTextIcon } from "lucide-react";
import { documentCitation, propositionSessionHref, type ConceptState, type GraphNode, type SnapshotDocument } from "@/src/core";
import { NodeKnowledge } from "@/components/node-knowledge";

/**
 * The graph's concept detail card, shared by the home graph and the "My
 * knowledge" graph: the name, the statement, the optional knowledge block and
 * the provenance ("Sessions": documents, imported files, deep-linkable chats).
 * The caller adds its own actions (the home graph's Delete) after the body.
 */

/** An open card: the node, the sources that touched it (chat ids and notes-source
 *  ids) and its canvas position at click time (camera moves dismiss the card, so
 *  it never needs re-anchoring). */
export interface CardSelection {
	node: GraphNode;
	sourceIds: string[];
	anchor: { x: number; y: number };
}

/** Position the card below its node: flipped above near the bottom edge, clamped
 *  horizontally. Imperative (ref + layout effect, before paint) because the flip
 *  needs the card's measured height; the card renders hidden until placed. */
export function useCardPlacement(
	selected: CardSelection | null,
	containerRef: RefObject<HTMLElement | null>,
): RefObject<HTMLDivElement | null> {
	const cardRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const card = cardRef.current;
		const container = containerRef.current;
		if (!selected || !card || !container) return;
		const width = card.offsetWidth;
		const height = card.offsetHeight;
		const margin = 8;
		const gap = 12;
		const left = Math.min(
			Math.max(selected.anchor.x - width / 2, margin),
			Math.max(container.clientWidth - width - margin, margin),
		);
		let top = selected.anchor.y + gap;
		if (top + height > container.clientHeight - margin) {
			top = Math.max(selected.anchor.y - gap - height, margin);
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.visibility = "visible";
	}, [selected, containerRef]);
	return cardRef;
}

export function NodeCardBody({
	node,
	sourceIds,
	sessions,
	fileSources,
	documents,
	knowledge,
}: {
	node: GraphNode;
	sourceIds: string[];
	/** chat id -> title. */
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	documents: Record<string, SnapshotDocument> | undefined;
	/** The "My knowledge" block: the concept's state and the titles of the sessions its evidence cites. */
	knowledge?: { state: ConceptState | undefined; sessions: Record<string, string> };
}) {
	return (
		<>
			<div className="text-sm font-medium leading-snug">{node.name}</div>
			<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{node.statement}</div>
			{knowledge && <NodeKnowledge state={knowledge.state} sessions={knowledge.sessions} />}
			{sourceIds.length > 0 ? (
				<div className="mt-3 flex flex-col gap-1">
					<div className="text-xs text-muted-foreground">Sessions</div>
					{sourceIds.map((sourceId) => {
						// A stored DOCUMENT (PR H): "<title> · §section · p.N", linked
						// to the reader at the page anchor. One line per distinct
						// place the node came up in.
						const doc = documents?.[sourceId];
						if (doc) {
							const cites = new Map<string, { label: string; page?: number }>();
							for (const pt of node.provenance) {
								if (pt.chatId !== sourceId) continue;
								const cite = documentCitation(doc, pt);
								cites.set(cite.label, cite);
							}
							if (cites.size === 0) cites.set(doc.title, { label: doc.title });
							return [...cites.values()].map((cite) => (
								<div key={`${sourceId}:${cite.label}`} className="flex items-center gap-1.5">
									<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
									<Link
										href={`/documents/${doc.id}${cite.page !== undefined ? `#p-${cite.page}` : ""}`}
										data-testid="card-document-link"
										className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
									>
										{cite.label}
									</Link>
								</div>
							));
						}
						// An imported-notes file: a STATIC entry — the path,
						// plain text, never a link (no session to open).
						if (fileSources[sourceId] !== undefined) {
							return (
								<div key={sourceId} className="flex items-center gap-1.5">
									<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">{fileSources[sourceId]}</span>
								</div>
							);
						}
						// A real session: deep-linkable provenance.
						return (
							<div key={sourceId} className="flex items-center gap-1.5">
								<Link
									href={propositionSessionHref(node, sourceId)}
									scroll={false}
									className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
								>
									{sessions[sourceId] ?? sourceId}
								</Link>
							</div>
						);
					})}
				</div>
			) : (
				<div className="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
			)}
		</>
	);
}
