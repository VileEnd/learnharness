"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { FileTextIcon, UploadIcon, XIcon } from "lucide-react";
import type { DocumentDecision, DuplicateVerdict } from "@/src/core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useBackDismiss } from "@/components/use-back-dismiss";
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

const ACCEPT = ".md,.markdown,.txt,.pdf,text/markdown,text/x-markdown,text/plain,application/pdf";

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
	onRemove,
	onDecide,
	onClose,
	onImport,
	fileInputRef,
}: {
	entries: Entry[];
	decisions: Record<number, DocumentDecision>;
	phase: "pick" | "importing" | "done";
	results: ImportTicket[];
	onPick: (files: FileList | null) => void;
	onRemove: (key: number) => void;
	onDecide: (key: number, decision: DocumentDecision) => void;
	onClose: () => void;
	onImport: () => void;
	fileInputRef?: React.RefObject<HTMLInputElement | null>;
}) {
	const toImport = entries.filter((e) => willImport(e, decisions));
	const skipped = entries.filter((e) => e.state === "ready" && !willImport(e, decisions)).length;
	const checking = entries.some((e) => e.state === "checking");
	const scanTotal = toImport.reduce((sum, e) => sum + (e.usd ?? 0), 0);
	const started = results.filter((r) => r.outcome === "started").length;
	const failed = results.filter((r) => r.outcome === "failed");
	return (
		<div
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
						<button
							type="button"
							onClick={() => fileInputRef?.current?.click()}
							disabled={phase === "importing"}
							data-testid="add-documents-pick"
							className="flex w-full flex-col items-center gap-1.5 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50 pointer-coarse:min-h-11"
						>
							<UploadIcon className="size-5" />
							<span>{entries.length === 0 ? "Choose files, or drop them here" : "Add more files"}</span>
							<span className="text-xs text-muted-foreground/80">Markdown, text, or PDF</span>
						</button>

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
							{phase === "importing" ? "Adding…" : "Import"}
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

async function postForm(url: string, files: File[], extra?: Record<string, string>): Promise<Response> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
	return fetch(url, { method: "POST", body: form });
}

function Dialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [decisions, setDecisions] = useState<Record<number, DocumentDecision>>({});
	const [phase, setPhase] = useState<"pick" | "importing" | "done">("pick");
	const [results, setResults] = useState<ImportTicket[]>([]);
	const files = useRef(new Map<number, File>());
	const nextKey = useRef(1);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const refreshActivity = useActivity().refresh;
	const busy = phase === "importing";
	const backdropDismiss = useBackdropDismiss(() => { if (!busy) onClose(); });
	useBackDismiss(true, () => { if (!busy) onClose(); });

	// Esc closes (claimed at the document level - the one-Esc law).
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || busy) return;
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

	const pick = useCallback(async (list: FileList | File[] | null) => {
		const picked = list ? Array.from(list) : [];
		if (picked.length === 0) return;
		const added: Entry[] = picked.map((file) => {
			const key = nextKey.current++;
			files.current.set(key, file);
			return { key, name: file.name, state: "checking" };
		});
		setEntries((cur) => [...cur, ...added]);
		const keys = added.map((e) => e.key);
		try {
			const res = await postForm("/api/documents/check", picked);
			const body = (await res.json()) as { results?: CheckResult[]; error?: string };
			if (!res.ok || !body.results) throw new Error(body.error ?? `Check failed (HTTP ${res.status})`);
			const byIndex = new Map(body.results.map((r) => [r.index, r]));
			patch(keys, (e) => {
				const check = byIndex.get(keys.indexOf(e.key));
				return check ? { ...e, state: "ready", check } : { ...e, state: "error", error: "No result for this file." };
			});
			// Scan estimates for the PDFs that would actually be scanned.
			const scannable = added.filter((e, i) => byIndex.get(i)?.kind === "pdf" && byIndex.get(i)?.verdict.status === "new" && !byIndex.get(i)?.scanned);
			if (scannable.length > 0) {
				const est = await postForm("/api/documents/estimate", scannable.map((e) => files.current.get(e.key)!));
				const estBody = (await est.json()) as Partial<Estimate> & { error?: string };
				if (!est.ok || !estBody.files) {
					// No sidecar (or unreachable): these PDFs cannot be imported here.
					patch(scannable.map((e) => e.key), (e) => ({ ...e, state: "error", error: estBody.error ?? "PDF scanning is unavailable." }));
				} else {
					const strategy = estBody.default_strategy ?? "";
					scannable.forEach((e, i) => {
						const f = estBody.files![i];
						patch([e.key], (cur) => ({ ...cur, usd: f?.usd?.[strategy], pages: f?.pages }));
					});
				}
			}
		} catch (err) {
			patch(keys, (e) => ({ ...e, state: "error", error: err instanceof Error ? err.message : String(err) }));
		}
	}, [patch]);

	const run = async () => {
		const send = entries.filter((e) => willImport(e, decisions));
		if (send.length === 0 || busy) return;
		setPhase("importing");
		try {
			const res = await postForm(
				"/api/documents/import",
				send.map((e) => files.current.get(e.key)!),
				{ decisions: JSON.stringify(send.map((e) => (e.check?.verdict.status === "new" ? null : decisions[e.key] ?? defaultDecision(e.check!.verdict)))) },
			);
			const body = (await res.json()) as { results?: ImportTicket[]; error?: string };
			if (!res.ok || !body.results) throw new Error(body.error ?? `Import failed (HTTP ${res.status})`);
			setResults(body.results);
		} catch (err) {
			setResults(send.map((e, index) => ({ index, name: e.name, outcome: "failed" as const, error: err instanceof Error ? err.message : String(err) })));
		}
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
				if (!busy && phase === "pick") void pick(e.dataTransfer.files);
			}}
		>
			<AddDocumentsBody
				entries={entries}
				decisions={decisions}
				phase={phase}
				results={results}
				onPick={(list) => void pick(list)}
				onRemove={(key) => {
					files.current.delete(key);
					setEntries((cur) => cur.filter((e) => e.key !== key));
				}}
				onDecide={(key, d) => setDecisions((cur) => ({ ...cur, [key]: d }))}
				onClose={onClose}
				onImport={() => void run()}
				fileInputRef={fileInputRef}
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
