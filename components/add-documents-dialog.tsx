"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { FileTextIcon, FolderIcon, UploadIcon, XIcon } from "lucide-react";
import { filterFolderPick, skippedNotice, type DocumentDecision, type DuplicateVerdict } from "@/src/core";
import { createTaskQueue, fileForm, jsonOf, tooLargeReason } from "@/components/add-documents-queue";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useBackDismiss } from "@/components/use-back-dismiss";
import { isTopModal, useModal } from "@/components/ui/use-modal";
import { useActivity } from "@/components/activity-dock";

/**
 * ADD DOCUMENTS (document library): the graph's import entry. Pick markdown,
 * text or PDF files; the server fingerprints each by CONTENT (never the
 * filename) and the dialog shows what it found - New, "Already imported as
 * <title>" (default Skip), or "92% similar to <title>" (Skip / Replace /
 * Import as new). PDFs show the scan cost the OCR sidecar estimates. Import
 * answers as soon as the files are accepted; scanning and extraction then
 * run in the background and live in the activity dock.
 *
 * Full-screen on phones (settings-dialog's frame: h-dvh + safe-area
 * padding), a centred card from sm up. Transport only: the wire shapes are
 * mirrored locally, never imported from the server.
 */

// ─── wire shapes (mirrors of POST /api/documents/{check,estimate,import}) ────

interface CheckResult {
	index: number;
	name: string;
	kind: "markdown" | "pdf";
	verdict: DuplicateVerdict;
	scanned?: boolean;
	error?: string;
	/** An old import of this file name that produced no nodes (new, with a hint). */
	legacyEmpty?: { sourceId: string; importedAt: string };
}

interface Estimate {
	files: { name: string; pages: number; usd: Record<string, number> }[];
	usd: Record<string, number>;
	default_strategy: string;
}

interface ImportTicket {
	index: number;
	name: string;
	outcome: "started" | "skipped" | "failed";
	error?: string;
}

/** One picked file and everything the check learned about it. */
export interface Entry {
	key: number;
	name: string;
	state: "checking" | "ready" | "error";
	check?: CheckResult;
	/** PDF scan estimate in USD (new, unscanned PDFs only). */
	usd?: number;
	pages?: number;
	error?: string;
}

const ACCEPT = ".md,.markdown,.txt,.nw,.pdf,text/markdown,text/x-markdown,text/plain,application/pdf";

// ─── pure helpers (exported for the SSR pins) ────────────────────────────────

/** The decision choices a verdict offers (exact duplicates are the same
 *  content, so "import as new" would be a no-op there). A file already in
 *  the graph from an old import is attached by default; extracting it again
 *  is the alternative. */
export function choicesFor(verdict: DuplicateVerdict): DocumentDecision[] {
	if (verdict.status === "legacy") return ["attach", "new", "skip"];
	return verdict.status === "similar" ? ["skip", "replace", "new"] : verdict.status === "duplicate" ? ["skip", "replace"] : [];
}

/** What happens to a matched file when the learner changes nothing. */
export function defaultDecision(verdict: DuplicateVerdict): DocumentDecision {
	return verdict.status === "legacy" ? "attach" : "skip";
}

export function statusLabel(verdict: DuplicateVerdict): string {
	const of = verdict.of;
	if (verdict.status === "legacy" && verdict.legacy) {
		const { importedAt, nodeCount } = verdict.legacy;
		return `Already in your graph · imported ${new Date(importedAt).toLocaleDateString()} · ${nodeCount} node${nodeCount === 1 ? "" : "s"} — add to library (no re-extraction)`;
	}
	if (verdict.status === "duplicate" && of) return `Already imported as ${of.title} · ${new Date(of.importedAt).toLocaleDateString()}`;
	if (verdict.status === "similar" && of) return `${Math.round((verdict.score ?? 0) * 100)}% similar to ${of.title}`;
	return "New";
}

const CHOICE_LABEL: Record<DocumentDecision, string> = { skip: "Skip", replace: "Replace", new: "Import as new", attach: "Add to library" };

/** "new" on an old import means extracting the file again. */
export const choiceLabel = (choice: DocumentDecision, verdict: DuplicateVerdict): string =>
	choice === "new" && verdict.status === "legacy" ? "Re-extract" : CHOICE_LABEL[choice];

/** Will this entry be sent? New files always; matched ones unless skipped. */
export function willImport(entry: Entry, decisions: Record<number, DocumentDecision>): boolean {
	if (entry.state !== "ready" || !entry.check) return false;
	if (entry.check.verdict.status === "new") return true;
	return (decisions[entry.key] ?? defaultDecision(entry.check.verdict)) !== "skip";
}

const usdLabel = (usd: number) => `≈ $${usd < 0.01 ? "<0.01" : usd.toFixed(2)}`;

// ─── the pure body ───────────────────────────────────────────────────────────

export function AddDocumentsBody({
	entries,
	decisions,
	phase,
	results,
	onPick,
	onPickFolder,
	notice,
	progress,
	onRemove,
	onDecide,
	onClose,
	onImport,
	fileInputRef,
	folderInputRef,
	rootRef,
}: {
	entries: Entry[];
	decisions: Record<number, DocumentDecision>;
	phase: "pick" | "importing" | "done";
	results: ImportTicket[];
	onPick: (files: FileList | null) => void;
	/** Present only where the browser can pick a folder (hidden on phones). */
	onPickFolder?: (files: FileList | null) => void;
	/** A short line under the pickers, e.g. how many folder files were skipped. */
	notice?: string;
	/** Files handed over so far while importing. */
	progress?: { done: number; total: number };
	onRemove: (key: number) => void;
	onDecide: (key: number, decision: DocumentDecision) => void;
	onClose: () => void;
	onImport: () => void;
	fileInputRef?: React.RefObject<HTMLInputElement | null>;
	folderInputRef?: React.RefObject<HTMLInputElement | null>;
	/** The wrapper's handle on the dialog root (for its Esc topmost check). */
	rootRef?: React.RefObject<HTMLDivElement | null>;
}) {
	const toImport = entries.filter((e) => willImport(e, decisions));
	const skipped = entries.filter((e) => e.state === "ready" && !willImport(e, decisions)).length;
	const checking = entries.some((e) => e.state === "checking");
	const scanTotal = toImport.reduce((sum, e) => sum + (e.usd ?? 0), 0);
	const started = results.filter((r) => r.outcome === "started").length;
	const failed = results.filter((r) => r.outcome === "failed");
	const ownRef = useRef<HTMLDivElement>(null);
	const ref = rootRef ?? ownRef;
	useModal(ref);
	return (
		<div
			ref={ref}
			role="dialog"
			aria-modal="true"
			aria-label="Add documents"
			data-testid="add-documents-dialog"
			onClick={(e) => e.stopPropagation()}
			className="settings-dialog-pop flex h-dvh w-full flex-col overflow-hidden border-border bg-card shadow-xl max-sm:pb-safe max-sm:pt-safe sm:h-auto sm:max-h-[85dvh] sm:w-[640px] sm:max-w-[90vw] sm:rounded-md sm:border"
		>
			<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				<h2 className="font-title text-2xl tracking-tight">Add documents</h2>
				<button
					type="button"
					aria-label="Close"
					data-testid="add-documents-close"
					onClick={onClose}
					className="ml-auto flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-11"
				>
					<XIcon className="size-4" />
				</button>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{phase === "done" ? (
					<div data-testid="add-documents-done" className="space-y-3 text-sm">
						<p className="text-foreground">
							{started > 0
								? `${started} document${started === 1 ? "" : "s"} added. Scanning and extraction continue in the background; follow them in the activity dock.`
								: "Nothing was added."}
						</p>
						{failed.map((r) => (
							<p key={r.index} role="alert" className="break-words text-xs text-red-400">
								{r.name}: {r.error}
							</p>
						))}
						<Link href="/documents" className="inline-block text-xs text-primary hover:underline">
							Open the document library
						</Link>
					</div>
				) : (
					<>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							accept={ACCEPT}
							className="hidden"
							data-testid="add-documents-input"
							onChange={(e) => {
								onPick(e.target.files);
								e.target.value = ""; // allow re-picking the same file
							}}
						/>
						{onPickFolder && (
							<input
								ref={folderInputRef}
								type="file"
								multiple
								className="hidden"
								data-testid="add-documents-folder-input"
								{...{ webkitdirectory: "" }}
								onChange={(e) => {
									onPickFolder(e.target.files);
									e.target.value = "";
								}}
							/>
						)}
						<div className="flex flex-col gap-2 sm:flex-row">
							<button
								type="button"
								onClick={() => fileInputRef?.current?.click()}
								disabled={phase === "importing"}
								data-testid="add-documents-pick"
								className="flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50 pointer-coarse:min-h-11"
							>
								<UploadIcon className="size-5" />
								<span>{entries.length === 0 ? "Choose files, or drop them here" : "Add more files"}</span>
								<span className="text-xs text-muted-foreground/80">Markdown, text, or PDF</span>
							</button>
							{onPickFolder && (
								<button
									type="button"
									onClick={() => folderInputRef?.current?.click()}
									disabled={phase === "importing"}
									data-testid="add-documents-pick-folder"
									className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50 sm:w-40"
								>
									<FolderIcon className="size-5" />
									<span>Add folder</span>
								</button>
							)}
						</div>
						{notice && (
							<p data-testid="add-documents-notice" className="mt-2 text-xs text-muted-foreground">
								{notice}
							</p>
						)}

						{entries.length > 0 && (
							<ul className="mt-4 space-y-2" data-testid="add-documents-list">
								{entries.map((entry) => (
									<EntryRow
										key={entry.key}
										entry={entry}
										decision={decisions[entry.key] ?? (entry.check ? defaultDecision(entry.check.verdict) : "skip")}
										disabled={phase === "importing"}
										onRemove={() => onRemove(entry.key)}
										onDecide={(d) => onDecide(entry.key, d)}
									/>
								))}
							</ul>
						)}
					</>
				)}
			</div>

			<footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-5 py-3">
				{phase !== "done" && entries.length > 0 && (
					<p className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="add-documents-summary">
						{checking ? "Checking…" : `${toImport.length} to add${skipped > 0 ? `, ${skipped} skipped` : ""}`}
						{scanTotal > 0 && ` · scanning ${usdLabel(scanTotal)}`}
					</p>
				)}
				<div className="ml-auto flex gap-2">
					<button
						type="button"
						onClick={onClose}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
					>
						{phase === "done" ? "Done" : "Cancel"}
					</button>
					{phase !== "done" && (
						<button
							type="button"
							onClick={onImport}
							disabled={phase === "importing" || checking || toImport.length === 0}
							data-testid="add-documents-import"
							className="rounded-sm border border-border bg-accent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent/70 disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-4"
						>
							{phase === "importing" ? (progress ? `Adding ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : "Adding…") : "Import"}
						</button>
					)}
				</div>
			</footer>
		</div>
	);
}

function EntryRow({
	entry,
	decision,
	disabled,
	onRemove,
	onDecide,
}: {
	entry: Entry;
	decision: DocumentDecision;
	disabled: boolean;
	onRemove: () => void;
	onDecide: (d: DocumentDecision) => void;
}) {
	const verdict = entry.check?.verdict;
	const choices = verdict ? choicesFor(verdict) : [];
	const problem = entry.state === "error" ? entry.error : entry.check?.error;
	return (
		<li data-testid="add-documents-row" className="rounded-md border border-border/70 px-3 py-2.5">
			<div className="flex min-w-0 items-start gap-2">
				<FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-foreground" title={entry.name}>
						{entry.name}
					</div>
					{entry.state === "checking" ? (
						<div className="text-xs text-muted-foreground">Checking…</div>
					) : problem ? (
						<div role="alert" className="break-words text-xs text-red-400">
							{problem}
						</div>
					) : verdict ? (
						<div data-testid="add-documents-status" data-status={verdict.status} className="break-words text-xs text-muted-foreground">
							<span className={verdict.status === "new" ? "text-foreground" : undefined}>{statusLabel(verdict)}</span>
							{entry.check?.legacyEmpty && (
								<span data-testid="add-documents-legacy-empty">
									{" · "}the old import of this file produced nothing, so it will be read again
								</span>
							)}
							{entry.check?.kind === "pdf" && (
								<>
									{entry.pages ? ` · ${entry.pages} pages` : ""}
									{entry.check.scanned ? " · already scanned, no cost" : entry.usd !== undefined ? ` · scan ${usdLabel(entry.usd)}` : ""}
								</>
							)}
						</div>
					) : null}
				</div>
				<button
					type="button"
					aria-label={`Remove ${entry.name}`}
					onClick={onRemove}
					disabled={disabled}
					className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 pointer-coarse:size-11"
				>
					<XIcon className="size-3.5" />
				</button>
			</div>
			{choices.length > 0 && !problem && (
				<div role="radiogroup" aria-label={`What to do with ${entry.name}`} className="mt-2 flex flex-wrap gap-1.5">
					{choices.map((choice) => (
						<button
							key={choice}
							type="button"
							role="radio"
							aria-checked={decision === choice}
							disabled={disabled}
							onClick={() => onDecide(choice)}
							className={
								"rounded-sm border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-3 " +
								(decision === choice ? "border-foreground/40 bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent")
							}
						>
							{verdict ? choiceLabel(choice, verdict) : CHOICE_LABEL[choice]}
						</button>
					))}
				</div>
			)}
		</li>
	);
}

// ─── the stateful dialog ─────────────────────────────────────────────────────

function Dialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [decisions, setDecisions] = useState<Record<number, DocumentDecision>>({});
	const [phase, setPhase] = useState<"pick" | "importing" | "done">("pick");
	const [results, setResults] = useState<ImportTicket[]>([]);
	const files = useRef(new Map<number, File>());
	const nextKey = useRef(1);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const folderInputRef = useRef<HTMLInputElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [notice, setNotice] = useState("");
	const [progress, setProgress] = useState<{ done: number; total: number }>();
	const [canPickFolder, setCanPickFolder] = useState(false);
	// One request per file, a few at a time; imports go one at a time so two
	// identical files in a selection still resolve to one document.
	const checks = useRef(createTaskQueue(3));
	const imports = useRef(createTaskQueue(1));
	const refreshActivity = useActivity().refresh;
	const busy = phase === "importing";
	const backdropDismiss = useBackdropDismiss(() => { if (!busy) onClose(); });
	useBackDismiss(true, () => { if (!busy) onClose(); });

	// Folder picking: desktop browsers only (phones fall back to the file picker).
	useEffect(() => {
		const phone = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
		setCanPickFolder("webkitdirectory" in HTMLInputElement.prototype && !phone);
	}, []);

	// Esc closes (claimed at the document level - the one-Esc law).
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !isTopModal(rootRef.current)) return;
			if (busy) {
				// Claimed even while importing, so it cannot chain into the window handlers.
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, onClose]);

	const patch = useCallback((keys: number[], update: (e: Entry) => Entry) => {
		setEntries((cur) => cur.map((e) => (keys.includes(e.key) ? update(e) : e)));
	}, []);

	/** Check one file, then (new, unscanned PDF) estimate its scan: two small requests. */
	const checkFile = useCallback(async (key: number, file: File) => {
		try {
			const res = await fetch("/api/documents/check", { method: "POST", body: fileForm(file) });
			const body = await jsonOf<{ results: CheckResult[] }>(res);
			const check = body.results?.[0];
			if (!res.ok || !check) throw new Error(body.error ?? `Check failed (HTTP ${res.status})`);
			patch([key], (e) => ({ ...e, state: "ready", check }));
			if (check.kind !== "pdf" || check.verdict.status !== "new" || check.scanned) return;
			const est = await fetch("/api/documents/estimate", { method: "POST", body: fileForm(file) });
			const estBody = await jsonOf<Estimate>(est);
			const f = estBody.files?.[0];
			if (!est.ok || !estBody.files) {
				// No sidecar (or unreachable): this PDF cannot be imported here.
				patch([key], (e) => ({ ...e, state: "error", error: estBody.error ?? "PDF scanning is unavailable." }));
			} else {
				patch([key], (e) => ({ ...e, usd: f?.usd?.[estBody.default_strategy ?? ""], pages: f?.pages }));
			}
		} catch (err) {
			patch([key], (e) => ({ ...e, state: "error", error: err instanceof Error ? err.message : String(err) }));
		}
	}, [patch]);

	const pick = useCallback((list: FileList | File[] | null) => {
		const picked = list ? Array.from(list) : [];
		if (picked.length === 0) return;
		for (const file of picked) {
			const key = nextKey.current++;
			files.current.set(key, file);
			const tooLarge = tooLargeReason(file);
			setEntries((cur) => [...cur, tooLarge ? { key, name: file.name, state: "error", error: tooLarge } : { key, name: file.name, state: "checking" }]);
			if (!tooLarge) void checks.current(() => checkFile(key, file));
		}
	}, [checkFile]);

	const pickFolder = useCallback((list: FileList | null) => {
		const { accepted, hidden, unsupported } = filterFolderPick(list ? Array.from(list) : []);
		setNotice(skippedNotice({ hidden, unsupported }));
		pick(accepted);
	}, [pick]);

	const run = async () => {
		const send = entries.filter((e) => willImport(e, decisions));
		if (send.length === 0 || busy) return;
		setPhase("importing");
		setProgress({ done: 0, total: send.length });
		const settled: ImportTicket[] = [];
		await Promise.all(
			send.map((e, index) =>
				imports.current(async () => {
					const file = files.current.get(e.key)!;
					const decision = e.check?.verdict.status === "new" ? null : decisions[e.key] ?? defaultDecision(e.check!.verdict);
					try {
						const res = await fetch("/api/documents/import", { method: "POST", body: fileForm(file, { decisions: JSON.stringify([decision]) }) });
						const body = await jsonOf<{ results: ImportTicket[] }>(res);
						const ticket = body.results?.[0];
						if (!res.ok || !ticket) throw new Error(body.error ?? `Import failed (HTTP ${res.status})`);
						settled[index] = { ...ticket, index, name: e.name };
					} catch (err) {
						settled[index] = { index, name: e.name, outcome: "failed", error: err instanceof Error ? err.message : String(err) };
					}
					setProgress((cur) => cur && { ...cur, done: cur.done + 1 });
				}),
			),
		);
		setResults(settled);
		setPhase("done");
		// The dock's start-site nudge: the runs announce themselves from their first phase on.
		refreshActivity();
		setTimeout(refreshActivity, 600);
		onImported();
	};

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			data-testid="add-documents-backdrop"
			{...backdropDismiss}
			onDragOver={(e) => e.preventDefault()}
			onDrop={(e) => {
				e.preventDefault();
				if (!busy && phase === "pick") pick(e.dataTransfer.files);
			}}
		>
			<AddDocumentsBody
				entries={entries}
				decisions={decisions}
				phase={phase}
				results={results}
				onPick={(list) => pick(list)}
				onPickFolder={canPickFolder ? pickFolder : undefined}
				notice={notice}
				progress={progress}
				onRemove={(key) => {
					files.current.delete(key);
					setEntries((cur) => cur.filter((e) => e.key !== key));
				}}
				onDecide={(key, d) => setDecisions((cur) => ({ ...cur, [key]: d }))}
				onClose={onClose}
				onImport={() => void run()}
				fileInputRef={fileInputRef}
				folderInputRef={folderInputRef}
				rootRef={rootRef}
			/>
		</div>,
		document.body,
	);
}

/** Mounts a fresh dialog (and so fresh state) each time it opens. */
export function AddDocumentsDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
	if (!open) return null;
	return <Dialog onClose={onClose} onImported={onImported} />;
}
