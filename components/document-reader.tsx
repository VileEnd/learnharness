"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { splitPages, type DocumentSummary } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { TopBar } from "@/components/top-bar";
import { DeleteDocumentDialog, type DocumentRemoval } from "@/components/delete-document-dialog";

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

export type RebuildPhase = "idle" | "confirm" | "sending" | "started";

/** A .nw document's rebuild: spends money, so it asks first and says how much
 *  work it is. */
export function RebuildPanel({
	chunks,
	phase,
	error,
	onAsk,
	onConfirm,
	onCancel,
}: {
	chunks: number;
	phase: RebuildPhase;
	error?: string;
	onAsk: () => void;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const button = "rounded-md border border-border/70 px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50 pointer-coarse:min-h-11";
	return (
		<div data-testid="document-rebuild" className="mt-4 rounded-lg border border-border/60 px-4 py-3 text-xs text-muted-foreground">
			{phase === "started" ? (
				<p>Rebuild started. The text is converted, and the concepts are being extracted again: follow it in the activity list. This can take a while.</p>
			) : phase === "idle" ? (
				<div className="flex flex-wrap items-center gap-3">
					<p className="min-w-0 flex-1">This document comes from a literate source file (.nw). Rebuilding reads its chapters and code properly.</p>
					<button type="button" onClick={onAsk} className={button}>
						Rebuild index…
					</button>
				</div>
			) : (
				<>
					<p>
						The text is converted right away, so search and reading improve at once. Its concepts are then extracted again: about {chunks} chunks,
						at least {chunks * 2} model calls on your extraction models (the checking step often needs several per chunk), which costs money.
					</p>
					<p className="mt-2">
						Your current concepts stay until the whole run succeeds. If it fails or you stop it, they stay and you can try again, but a new try reads
						the whole document again.
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						<button type="button" onClick={onConfirm} disabled={phase === "sending"} className={`${button} text-foreground`}>
							Start rebuild
						</button>
						<button type="button" onClick={onCancel} disabled={phase === "sending"} className={button}>
							Cancel
						</button>
					</div>
				</>
			)}
			{error && (
				<p role="alert" className="mt-2 text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

/** The title with its Rename action: the owner's title is kept when the
 *  document is described again, rebuilt or replaced. `onRename` resolves to an
 *  error message to show, or nothing when saved. */
export function TitleEditor({ title, onRename }: { title: string; onRename?: (title: string) => Promise<string | void> }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const small = "rounded-md border border-border/70 px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50 pointer-coarse:min-h-11";
	async function save() {
		if (!onRename || busy) return;
		setBusy(true);
		setError(undefined);
		const failed = await onRename(draft);
		setBusy(false);
		if (failed) setError(failed);
		else setEditing(false);
	}
	if (!editing) {
		return (
			<div className="flex items-start gap-2">
				<h1 className="min-w-0 flex-1 break-words font-title text-3xl tracking-tight">{title}</h1>
				{onRename && (
					<button
						type="button"
						data-testid="document-rename"
						aria-label="Rename document"
						title="Rename"
						onClick={() => {
							setDraft(title);
							setError(undefined);
							setEditing(true);
						}}
						className="mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-11"
					>
						<PencilIcon className="size-3.5" />
					</button>
				)}
			</div>
		);
	}
	return (
		<form
			data-testid="document-rename-form"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<input
				autoFocus
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => e.key === "Escape" && !busy && setEditing(false)}
				maxLength={200}
				aria-label="Document title"
				className="h-11 w-full rounded-lg border bg-background px-3 text-lg outline-none focus:border-ring"
			/>
			<div className="mt-2 flex gap-2">
				<button type="submit" disabled={busy || draft.trim() === ""} className={`${small} text-foreground`}>
					{busy ? "Saving…" : "Save"}
				</button>
				<button type="button" disabled={busy} onClick={() => setEditing(false)} className={small}>
					Cancel
				</button>
			</div>
			{error && (
				<p role="alert" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
		</form>
	);
}

export function DocumentReaderBody({
	meta,
	markdown,
	rebuild,
	rebuildPhase = "idle",
	rebuildError,
	onRebuildAsk = () => {},
	onRebuildConfirm = () => {},
	onRebuildCancel = () => {},
	onRename,
	onDelete,
}: {
	meta: DocumentSummary;
	markdown: string;
	rebuild?: { chunks: number };
	rebuildPhase?: RebuildPhase;
	rebuildError?: string;
	onRebuildAsk?: () => void;
	onRebuildConfirm?: () => void;
	onRebuildCancel?: () => void;
	onRename?: (title: string) => Promise<string | void>;
	onDelete?: () => void;
}) {
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
				{onDelete && (
					<button
						type="button"
						data-testid="document-delete"
						aria-label="Delete document"
						title="Delete document"
						onClick={onDelete}
						className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive pointer-coarse:size-11"
					>
						<Trash2Icon className="size-4" />
					</button>
				)}
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 pb-safe sm:px-8">
				<article className="mx-auto min-w-0 max-w-3xl">
					<TitleEditor key={meta.title} title={meta.title} onRename={onRename} />
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
						<p className="mt-2 break-words text-[11px] text-muted-foreground-70">Also known as {meta.filenames.join(" · ")}</p>
					)}
					{rebuild && (
						<RebuildPanel
							chunks={rebuild.chunks}
							phase={rebuildPhase}
							error={rebuildError}
							onAsk={onRebuildAsk}
							onConfirm={onRebuildConfirm}
							onCancel={onRebuildCancel}
						/>
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
							// A long document mounts one markdown renderer per page; the browser
							// skips layout and paint of off-screen pages (auto keeps the measured
							// height once a page has been seen, so the scrollbar stays steady).
							<section
								key={i}
								id={p.page !== null ? `p-${p.page}` : undefined}
								className={`min-w-0 scroll-mt-20${numbered.length > 1 ? " [content-visibility:auto] [contain-intrinsic-size:auto_48rem]" : ""}`}
							>
								{p.page !== null && numbered.length > 1 && (
									<div className="mb-2 text-[11px] uppercase tracking-widest text-muted-foreground-70">Page {p.page}</div>
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

export function DocumentReader(props: { meta: DocumentSummary; markdown: string; rebuild?: { chunks: number }; removal: DocumentRemoval }) {
	const { removal, ...body } = props;
	const router = useRouter();
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [rebuildPhase, setRebuildPhase] = useState<RebuildPhase>("idle");
	const [rebuildError, setRebuildError] = useState<string>();
	// The SSR'd anchors exist before hydration, but the markdown renders in
	// after it: re-honour a #p-N deep link once the sections are real.
	useEffect(() => {
		const hash = window.location.hash;
		if (!hash) return;
		const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView(), 250);
		return () => clearTimeout(t);
	}, []);

	async function startRebuild() {
		setRebuildPhase("sending");
		setRebuildError(undefined);
		try {
			const res = await fetch(`/api/documents/${encodeURIComponent(props.meta.id)}/rebuild`, { method: "POST" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `The server answered ${res.status}.`);
			}
			setRebuildPhase("started");
			router.refresh(); // the converted text
		} catch (err) {
			setRebuildError(err instanceof Error ? err.message : String(err));
			setRebuildPhase("idle");
		}
	}

	async function rename(title: string): Promise<string | void> {
		try {
			const res = await fetch(`/api/documents/${encodeURIComponent(props.meta.id)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title }),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => null)) as { error?: string } | null;
				return err?.error ?? `The server answered ${res.status}.`;
			}
			router.refresh();
		} catch {
			return "Rename failed: network error. Try again.";
		}
	}

	return (
		<>
			<DocumentReaderBody
				{...body}
				onRename={rename}
				onDelete={() => setDeleteOpen(true)}
				rebuildPhase={rebuildPhase}
				rebuildError={rebuildError}
				onRebuildAsk={() => setRebuildPhase("confirm")}
				onRebuildConfirm={() => void startRebuild()}
				onRebuildCancel={() => setRebuildPhase("idle")}
			/>
			<DeleteDocumentDialog
				docId={props.meta.id}
				title={props.meta.title}
				removal={removal}
				open={deleteOpen}
				onClose={() => setDeleteOpen(false)}
				onDeleted={() => {
					router.push("/documents");
					router.refresh();
				}}
			/>
		</>
	);
}
