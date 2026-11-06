"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useBackDismiss } from "@/components/use-back-dismiss";

/** What a delete takes: concepts only this document supports, and the shared
 *  ones (other documents or chats also support them) that stay. */
export interface DocumentRemoval {
	concepts: number;
	shared: number;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The impact sentences (exported pure for pins). */
export function removalLines(removal: DocumentRemoval): string[] {
	const lines = [
		removal.concepts > 0
			? `${count(removal.concepts, "concept is", "concepts are")} supported only by this document and will be deleted from the knowledge graph.`
			: "No concept depends on this document alone.",
	];
	if (removal.shared > 0) {
		lines.push(`${count(removal.shared, "concept is", "concepts are")} also supported by other documents or sessions and will stay.`);
	}
	return lines;
}

/**
 * Document deletion: the confirm surface, portaled like the node dialog it
 * follows. Says what goes (the document, its search index, its exclusive
 * concepts) and what stays (shared concepts, your learning record). A phone
 * gets full-size touch targets and a dialog that never exceeds the viewport.
 */
export function DeleteDocumentBody({
	title,
	removal,
	busy,
	failure,
	onClose,
	onRun,
}: {
	title: string;
	removal: DocumentRemoval;
	busy: boolean;
	failure: string | null;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete document"
			data-testid="delete-document-dialog"
			onClick={(e) => e.stopPropagation()}
			className="max-h-[calc(100dvh-2rem)] w-[32rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete document?</h2>
			<p data-testid="delete-document-title" className="mt-1.5 break-words font-mono text-sm text-foreground">
				{title}
			</p>
			<p className="mt-2 text-sm text-muted-foreground">
				This permanently deletes the document, its text and its search index. This cannot be undone.
			</p>
			<ul data-testid="delete-document-impact" className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
				{removalLines(removal).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			<p className="mt-2 text-xs text-muted-foreground/80">Your answers and learning record are kept.</p>
			{failure && (
				<div role="alert" data-testid="delete-document-failure" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs text-foreground">
					{failure}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-document-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-4"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-document-confirm"
					onClick={onRun}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-4"
				>
					{busy ? "Deleting…" : failure ? "Try again" : "Delete"}
				</button>
			</div>
		</div>
	);
}

export function DeleteDocumentDialog({
	docId,
	title,
	removal,
	open,
	onClose,
	onDeleted,
}: {
	docId: string;
	title: string;
	removal: DocumentRemoval;
	open: boolean;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useBackDismiss(open, () => {
		if (!busy) onClose();
	});
	useEffect(() => {
		if (!open) {
			setBusy(false);
			setFailure(null);
		}
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			if (!busy) onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, busy, onClose]);

	async function run() {
		if (busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/documents/${encodeURIComponent(docId)}`, { method: "DELETE" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setFailure(body?.error ?? `Delete failed (${res.status}).`);
				setBusy(false);
				return;
			}
			onDeleted();
		} catch {
			setFailure("Delete failed: network error. Try again.");
			setBusy(false);
		}
	}

	if (!open) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<DeleteDocumentBody title={title} removal={removal} busy={busy} failure={failure} onClose={onClose} onRun={() => void run()} />
		</div>,
		document.body,
	);
}
