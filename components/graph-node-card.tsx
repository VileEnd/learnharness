"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import Link from "next/link";
import { FileTextIcon } from "lucide-react";
import { documentCitation, propositionSessionHref, type ConceptState, type GraphNode, type SnapshotDocument } from "@/src/core";
import { NodeKnowledge } from "@/components/node-knowledge";
import { ToolContentResponse } from "@/components/ai-elements/message";

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

/** Place the card below its node: flipped above near the bottom edge, clamped
 *  horizontally. It runs once at selection and again whenever the card or its
 *  container changes size, because rendered math, tables and fonts can resize
 *  the card after the first measure. Returns the cleanup. The card renders
 *  hidden until placed. */
export function observeNodeCardPosition(
	card: HTMLDivElement,
	container: HTMLElement,
	anchor: { x: number; y: number },
): () => void {
	const place = () => {
		const width = card.offsetWidth;
		const height = card.offsetHeight;
		const margin = 8;
		const gap = 12;
		const left = Math.min(Math.max(anchor.x - width / 2, margin), Math.max(container.clientWidth - width - margin, margin));
		let top = anchor.y + gap;
		if (top + height > container.clientHeight - margin) {
			top = Math.max(anchor.y - gap - height, margin);
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.visibility = "visible";
	};
	place();
	const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
	observer?.observe(card);
	observer?.observe(container);
	return () => observer?.disconnect();
}

/** Position the card (see observeNodeCardPosition). Imperative (ref + layout
 *  effect, before paint) because the flip needs the card's measured height. */
export function useCardPlacement(
	selected: CardSelection | null,
	containerRef: RefObject<HTMLElement | null>,
): RefObject<HTMLDivElement | null> {
	const cardRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const card = cardRef.current;
		const container = containerRef.current;
		if (!selected || !card || !container) return;
		return observeNodeCardPosition(card, container, selected.anchor);
	}, [selected, containerRef]);
	return cardRef;
}

/** The card's name and statement. Both are model output or imported text, so
 *  they render through ToolContentResponse like other tool content: Markdown
 *  and math, sanitised by the shared pipeline, never streamed. `.lh-prose`
 *  sets the chat font and size in unlayered CSS that beats Tailwind's type
 *  utilities; the variable overrides keep the card's own type. */
const NODE_CARD_TYPE = "[--font-prose:var(--font-ui)] " +
	"[&_[data-streamdown=inline-code]]:[font-size:inherit] [&_[data-streamdown=inline-code]]:[color:inherit]";
function NodeCardText({ name, statement }: Pick<GraphNode, "name" | "statement">) {
	return (
		<>
			<ToolContentResponse
				mode="static"
				className={`${NODE_CARD_TYPE} font-medium [--lh-prose-size:var(--text-sm)] [--lh-prose-leading:1.375]`}
			>
				{name}
			</ToolContentResponse>
			<ToolContentResponse
				mode="static"
				className={`${NODE_CARD_TYPE} mt-1 text-muted-foreground [--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625]`}
			>
				{statement}
			</ToolContentResponse>
		</>
	);
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
			<NodeCardText name={node.name} statement={node.statement} />
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
