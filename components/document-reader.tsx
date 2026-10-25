"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { splitPages, type DocumentSummary } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { TopBar } from "@/components/top-bar";

/**
 * THE DOCUMENT READER (/documents/[id]): the stored markdown rendered with
 * the app's own markdown stack (math, mermaid, tables), one block per page
 * so each page has a #p-N anchor (the graph's detail cards will link there).
 * The OCR page-image references point at files that are not stored, so they
 * are dropped rather than rendered broken.
 */

/** Drop `![page N](...)` lines (images the sidecar wrote beside its markdown). */
export function withoutPageImages(markdown: string): string {
	return markdown.replace(/^[ \t]*!\[page \d+\]\([^)]*\)[ \t]*\r?\n?/gim, "");
}

export function DocumentReaderBody({ meta, markdown }: { meta: DocumentSummary; markdown: string }) {
	const pages = splitPages(markdown);
	const numbered = pages.filter((p) => p.page !== null);
	return (
		<div data-testid="document-reader" className="flex h-full min-h-0 flex-col">
			<TopBar>
				<Link
					href="/documents"
					aria-label="Back to documents"
					className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<ArrowLeftIcon className="size-4" />
				</Link>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta.title}</span>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 pb-safe sm:px-8">
				<article className="mx-auto min-w-0 max-w-3xl">
					<h1 className="break-words font-title text-3xl tracking-tight">{meta.title}</h1>
					<p className="mt-1 text-xs text-muted-foreground">
						{meta.origin === "pdf" ? "Scanned PDF" : "Markdown"}
						{meta.pages ? ` · ${meta.pages} pages` : ""} · added {meta.importedAt.slice(0, 10)}
						{meta.ocr ? ` · scan cost $${meta.ocr.costUsd.toFixed(4)}` : ""}
					</p>
					{meta.summary && <p className="mt-3 text-sm text-muted-foreground">{meta.summary}</p>}
					{meta.topics.length > 0 && (
						<div className="mt-3 flex flex-wrap gap-1.5">
							{meta.topics.map((t) => (
								<span key={t} className="max-w-full break-words rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
									{t}
								</span>
							))}
						</div>
					)}
					{meta.filenames.length > 0 && (
						<p className="mt-2 break-words text-[11px] text-muted-foreground/70">Also known as {meta.filenames.join(" · ")}</p>
					)}
					{numbered.length > 1 && (
						<nav aria-label="Pages" data-testid="document-page-nav" className="mt-4 flex flex-wrap gap-1.5">
							{numbered.map((p) => (
								<a
									key={p.page}
									href={`#p-${p.page}`}
									className="flex min-w-7 items-center justify-center rounded-md border border-border/70 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent pointer-coarse:min-h-11 pointer-coarse:min-w-11"
								>
									{p.page}
								</a>
							))}
						</nav>
					)}
					<div className="mt-6 space-y-8">
						{pages.map((p, i) => (
							<section key={i} id={p.page !== null ? `p-${p.page}` : undefined} className="min-w-0 scroll-mt-20">
								{p.page !== null && numbered.length > 1 && (
									<div className="mb-2 text-[11px] uppercase tracking-widest text-muted-foreground/70">Page {p.page}</div>
								)}
								<div className="min-w-0 overflow-x-auto">
									<MessageResponse>{withoutPageImages(p.markdown)}</MessageResponse>
								</div>
							</section>
						))}
					</div>
				</article>
			</div>
		</div>
	);
}

export function DocumentReader(props: { meta: DocumentSummary; markdown: string }) {
	// The SSR'd anchors exist before hydration, but the markdown renders in
	// after it: re-honour a #p-N deep link once the sections are real.
	useEffect(() => {
		const hash = window.location.hash;
		if (!hash) return;
		const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView(), 250);
		return () => clearTimeout(t);
	}, []);
	return <DocumentReaderBody {...props} />;
}
