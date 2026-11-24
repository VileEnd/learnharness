"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useBackDismiss } from "@/components/use-back-dismiss";
import { isTopModal, useModal } from "@/components/ui/use-modal";
import type { SessionFolder } from "@/src/core";

/**
 * Folder deletion (session folders, owner design 2026-11-24): a simple
 * confirm in the delete-session dialog's shape. Deleting removes the folder
 * only; its sessions return to the unfiled list and are never deleted.
 * The wrapper owns the request, Esc, backdrop and back gesture; the body is
 * pure for render pins.
 */
export function DeleteFolderDialog({
	folder,
	sessionCount,
	onClose,
	onDeleted,
}: {
	/** The folder up for deletion; null = closed. */
	folder: SessionFolder | null;
	/** How many sessions it holds (all kinds), for the copy. */
	sessionCount: number;
	onClose: () => void;
	/** Success: the server's fresh view, for the sidebar to adopt. */
	onDeleted: (view: unknown) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useBackDismiss(folder !== null, () => {
		if (!busy) onClose();
	});

	useEffect(() => {
		if (!folder) {
			setBusy(false);
			setFailure(null);
		}
	}, [folder]);

	useEffect(() => {
		if (!folder) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isTopModal(rootRef.current)) {
				e.preventDefault();
				e.stopPropagation();
				if (!busy) onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [folder, busy, onClose]);

	const run = async () => {
		if (!folder || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/session-folders/${folder.id}`, { method: "DELETE" });
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setFailure(body.error === "folder_not_found" ? "This folder is already gone." : `Delete failed (${res.status}).`);
				setBusy(false);
				return;
			}
			onDeleted(body);
		} catch {
			setFailure("Delete failed — network error. Try again.");
			setBusy(false);
		}
	};

	if (!folder) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<DeleteFolderBody folder={folder} sessionCount={sessionCount} busy={busy} failure={failure} onClose={onClose} onRun={() => void run()} rootRef={rootRef} />
		</div>,
		document.body,
	);
}

export function DeleteFolderBody({
	folder,
	sessionCount,
	busy,
	failure,
	onClose,
	onRun,
	rootRef,
}: {
	folder: Pick<SessionFolder, "name">;
	sessionCount: number;
	busy: boolean;
	failure: string | null;
	onClose: () => void;
	onRun: () => void;
	rootRef?: React.RefObject<HTMLDivElement | null>;
}) {
	const ownRef = useRef<HTMLDivElement>(null);
	const ref = rootRef ?? ownRef;
	useModal(ref);
	const sessions = sessionCount === 1 ? "Its session moves" : sessionCount === 0 ? "It holds no sessions" : `Its ${sessionCount} sessions move`;
	return (
		<div
			ref={ref}
			role="dialog"
			aria-modal="true"
			aria-label="Delete folder"
			data-testid="delete-folder-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete folder?</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{folder.name}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				Only the folder is removed. {sessions}
				{sessionCount === 0 ? "." : " back to the session list; no session is deleted."}
			</p>
			{failure && (
				<div role="alert" data-testid="delete-folder-failure" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs text-foreground">
					{failure}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-folder-cancel"
					data-autofocus
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-4"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-folder-confirm"
					onClick={onRun}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-4"
				>
					{busy ? "Deleting…" : "Delete folder"}
				</button>
			</div>
		</div>
	);
}
