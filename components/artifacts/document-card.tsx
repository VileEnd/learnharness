"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The document tools' transcript card (PR I): one quiet collapsed line per
 * call - "Searched documents: <query> · N hits", "Read <title> § … p.N",
 * "Listed documents · N" - expanding to the hits / the place that was read,
 * each linking into the reader at its page anchor (/documents/<docId>#p-N).
 * It renders from the tool result's `details` (ids, titles, pages; never the
 * document text) and the call's input.
 */

interface ToolPart {
	type: string;
	state: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
}

interface Hit {
	docId: string;
	title: string;
	sectionId: string;
	headingPath: string[];
	pageFrom?: number;
	pageTo?: number;
	snippet?: string;
}

type Details =
	| { kind: "search"; query: string; mode: "hybrid" | "keyword"; note?: string; hits: Hit[] }
	| { kind: "read"; ok: boolean; error?: string; docId?: string; title?: string; label?: string; pageFrom?: number; pageTo?: number; truncated?: boolean }
	| { kind: "list"; topic?: string; count: number };

const pageText = (from?: number, to?: number) =>
	from === undefined ? "" : to === undefined || to === from ? `p.${from}` : `p.${from}-${to}`;

/** The reader link: the page anchor when the place has a page. */
export const documentHref = (docId: string, pageFrom?: number) =>
	pageFrom === undefined ? `/documents/${docId}` : `/documents/${docId}#p-${pageFrom}`;

function detailsOf(output: unknown): Details | null {
	const o = output as { kind?: unknown } | null;
	return o && typeof o === "object" && (o.kind === "search" || o.kind === "read" || o.kind === "list") ? (o as Details) : null;
}

/** The collapsed one-liner. Pure, exported for tests. */
export function documentSummary(tool: string, input: unknown, details: Details | null): string {
	const inp = (input ?? {}) as Record<string, unknown>;
	if (details?.kind === "search") return `Searched documents: ${details.query} · ${details.hits.length} ${details.hits.length === 1 ? "hit" : "hits"}`;
	if (details?.kind === "read") {
		if (!details.ok) return `Could not read ${typeof inp.document === "string" ? inp.document : "document"}`;
		// A page-range label already carries its pages; a section label gets them appended.
		const where = details.label?.startsWith("pages")
			? details.label
			: [details.label, pageText(details.pageFrom, details.pageTo)].filter(Boolean).join(" ");
		return `Read ${details.title ?? ""} ${where}`.trim();
	}
	if (details?.kind === "list") return `Listed documents${details.topic ? ` on ${details.topic}` : ""} · ${details.count}`;
	if (tool === "search_documents" && typeof inp.query === "string") return `Searching documents: ${inp.query}`;
	if (tool === "read_document" && typeof inp.document === "string") return `Reading ${inp.document}`;
	return "Listing documents";
}

const LINK = "break-words font-medium text-foreground underline-offset-2 hover:underline";

export function DocumentCard({ part }: ArtifactPartProps) {
	const p = part as ToolPart;
	const tool = p.type.replace(/^tool-/, "");
	const details = detailsOf(p.output);
	const failed = p.state === "output-error" || typeof p.errorText === "string";
	return (
		<details data-testid="document-card" data-tool={tool} className="group my-1 w-full max-w-2xl select-none">
			<summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				<span className={`min-w-0 truncate ${failed ? "text-red-500" : ""}`}>{documentSummary(tool, p.input, details)}</span>
				<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-2 space-y-2 rounded-xl border bg-card p-3 text-xs">
				{typeof p.errorText === "string" && <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-red-500">{p.errorText}</pre>}
				{details?.kind === "search" && (
					<>
						{details.note && <p className="text-muted-foreground">{details.note}</p>}
						{details.hits.length === 0 && <p className="text-muted-foreground">No passages matched.</p>}
						<ul className="space-y-2">
							{details.hits.map((h, i) => (
								<li key={`${h.docId}-${h.sectionId}-${i}`} className="min-w-0">
									<Link href={documentHref(h.docId, h.pageFrom)} className={LINK}>
										{h.title}
									</Link>
									<span className="text-muted-foreground">
										{" "}
										{[h.headingPath.join(" › "), pageText(h.pageFrom, h.pageTo)].filter(Boolean).join(" · ")}
									</span>
									{h.snippet && <p className="mt-0.5 break-words text-muted-foreground">{h.snippet}</p>}
								</li>
							))}
						</ul>
					</>
				)}
				{details?.kind === "read" &&
					(details.ok && details.docId ? (
						<p className="break-words">
							<Link href={documentHref(details.docId, details.pageFrom)} className={LINK}>
								{details.title}
							</Link>
							<span className="text-muted-foreground">
								{" "}
								{[details.label, pageText(details.pageFrom, details.pageTo)].filter(Boolean).join(" · ")}
								{details.truncated ? " · capped, continued with an offset" : ""}
							</span>
						</p>
					) : (
						<p className="break-words text-muted-foreground">{details.error}</p>
					))}
				{details?.kind === "list" && <p className="text-muted-foreground">{details.count} documents in the library.</p>}
				{!details && !p.errorText && <p className="italic text-muted-foreground">running…</p>}
			</div>
		</details>
	);
}
