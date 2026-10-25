/**
 * The document library's service (PR G): the duplicate check and the import
 * flow behind app/api/documents/*. Routes are transport only; every decision
 * lives here.
 *
 * IDENTITY IS CONTENT. A markdown file is fingerprinted from its normalised
 * text, a PDF from its bytes; the filename is stored as an alias and never
 * decides anything (core/documents.ts). check() classifies each file against
 * the library (new | duplicate | similar); importFiles() applies the
 * learner's per-file decision (skip | replace | new):
 *
 *   markdown  describe (content only, unless OCR front matter already says
 *             what it is) -> store -> extraction
 *   pdf       OCR sidecar job (polled, shown as a "Scanning" activity row
 *             with abort) -> markdown -> store -> re-check the text for a
 *             duplicate of something else -> extraction
 *
 * The slow part of a file (extraction, scanning) runs in the background -
 * never tied to the request. importFiles() returns once every file is
 * accepted or refused; each ticket's `completion` settles when its background
 * work ends (the blocking /api/graph/import alias awaits it, the new route
 * ignores it). Extraction is the existing notes pipeline with the DOCUMENT
 * as the source identity: its id is the provenance source id and its title -
 * never the filename - is what the extractor sees.
 */

import type { EmissionStats } from "../core/graph.ts";
import type { DocumentDecision, DocumentMeta, DocumentSummary, DuplicateVerdict } from "../core/contracts/documents.ts";
import type { DocumentStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import {
	classify,
	describedByFrontMatter,
	documentIdFor,
	fingerprint,
	normalizeText,
	normalizeTopics,
	parseFrontMatter,
	sha256Hex,
} from "../core/documents.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import type { NotesImportInput } from "../agent/subagents/extraction.ts";
import { NotesImportError } from "../agent/subagents/extraction.ts";
import type { DocumentDescription } from "../agent/subagents/describe.ts";
import { OcrError, type OcrClient, type OcrKnown } from "./ocr-client.ts";
import type { PushEvent } from "./push.ts";

// ─── inputs / outputs ────────────────────────────────────────────────────────

export interface IncomingFile {
	name: string;
	bytes: Uint8Array;
}

export type DocumentKind = "markdown" | "pdf";

export interface CheckResult {
	index: number;
	name: string;
	kind: DocumentKind;
	verdict: DuplicateVerdict;
	/** PDF only: the sidecar already converted these exact bytes, so
	 *  importing costs nothing. */
	scanned?: boolean;
	/** The file cannot be imported (binary content, empty). */
	error?: string;
}

export interface ImportCompletion {
	ok: boolean;
	docId?: string;
	stats?: EmissionStats;
	/** Extraction ended short of complete (NotesImportError.outcome). */
	outcome?: "completed" | "failed" | "partial" | "aborted" | "busy" | "skipped";
	/** The scanned text turned out to duplicate another document. */
	duplicateOf?: { id: string; title: string };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

export interface ImportTicket {
	index: number;
	name: string;
	/** started: accepted, work continues in the background. */
	outcome: "started" | "skipped" | "failed";
	docId?: string;
	title?: string;
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	completion?: Promise<ImportCompletion>;
}

export interface DocumentServiceDeps {
	store: DocumentStore;
	importNotes(input: NotesImportInput): Promise<EmissionStats>;
	describe(text: string, signal?: AbortSignal): Promise<DocumentDescription>;
	ocr: OcrClient;
	notify(event: PushEvent): void | Promise<void>;
	now?: () => Date;
	/** OCR job poll interval (default 2s; tests pass 0). */
	pollMs?: number;
}

// ─── the scan registry (the activity dock's "Scanning" rows) ────────────────

export interface RunningScan {
	id: string;
	title: string;
	startedAt: number;
	controller: AbortController;
}

interface LhScanGlobal {
	__lhDocumentScans?: Map<string, RunningScan>;
}

function scans(): Map<string, RunningScan> {
	const g = globalThis as LhScanGlobal;
	return (g.__lhDocumentScans ??= new Map());
}

/** The running PDF scans, oldest first (the activity feed reads this). */
export function scanStatuses(): { id: string; title: string; startedAt: number }[] {
	return [...scans().values()]
		.map(({ id, title, startedAt }) => ({ id, title, startedAt }))
		.sort((a, b) => a.startedAt - b.startedAt);
}

/** The dock's abort for a scan row; idempotent (nothing running = fine). */
export function abortScan(id: string): void {
	scans().get(id)?.controller.abort();
}

// ─── pure helpers ────────────────────────────────────────────────────────────

/** The multipart field "files" as bytes (the routes' one parsing step). */
export async function incomingFiles(form: FormData): Promise<IncomingFile[]> {
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

const isPdf = (bytes: Uint8Array): boolean =>
	bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;

/** A text file decodes as UTF-8 without NULs; anything else is not importable. */
function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	return new TextDecoder("utf-8").decode(bytes);
}

const stem = (name: string) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") || name;

const asSummary = ({ minhash: _sketch, ...rest }: DocumentMeta): DocumentSummary => rest;

/** Candidate = what the identity layer derives from markdown. */
function candidateOf(markdown: string, pdfSha256?: string) {
	const fp = fingerprint(markdown);
	return { ...fp, ...(pdfSha256 ? { pdfSha256 } : {}) };
}

export function createDocumentService(deps: DocumentServiceDeps) {
	const { store, ocr } = deps;
	const now = () => (deps.now ?? (() => new Date()))().toISOString();
	const pollMs = deps.pollMs ?? 2000;

	// ── check ─────────────────────────────────────────────────────────────────

	async function checkOne(file: IncomingFile, index: number, metas: DocumentMeta[]): Promise<CheckResult> {
		if (isPdf(file.bytes)) {
			const pdfSha256 = sha256Hex(file.bytes);
			const byBytes = metas.find((m) => m.pdfSha256 === pdfSha256);
			if (byBytes) {
				return { index, name: file.name, kind: "pdf", verdict: classify(metas, { contentHash: "", minhash: [], pdfSha256 }) };
			}
			// Not imported yet - but the sidecar may have converted these bytes
			// before; its markdown can be classified like any text (best effort).
			const known = await knownScan(pdfSha256);
			if (known) {
				const markdown = await ocr.markdown(known.job, known.markdown).catch(() => null);
				const verdict = markdown ? classify(metas, candidateOf(markdown, pdfSha256)) : { status: "new" as const };
				return { index, name: file.name, kind: "pdf", verdict, scanned: true };
			}
			return { index, name: file.name, kind: "pdf", verdict: { status: "new" } };
		}
		const text = decodeText(file.bytes);
		if (text === null) return { index, name: file.name, kind: "markdown", verdict: { status: "new" }, error: "Not a text or PDF file." };
		if (normalizeText(text) === "") return { index, name: file.name, kind: "markdown", verdict: { status: "new" }, error: "The file is empty." };
		return { index, name: file.name, kind: "markdown", verdict: classify(metas, candidateOf(text)) };
	}

	async function knownScan(pdfSha256: string): Promise<OcrKnown | null> {
		if (!ocr.configured()) return null;
		try {
			return await ocr.bySha(pdfSha256);
		} catch (err) {
			console.info(`[documents] sidecar lookup skipped: ${err instanceof Error ? err.message : err}`);
			return null;
		}
	}

	/** Classify every file against the library. Needs no model key. */
	async function check(files: IncomingFile[]): Promise<CheckResult[]> {
		const metas = store.listMetas();
		const results: CheckResult[] = [];
		for (const [index, file] of files.entries()) results.push(await checkOne(file, index, metas));
		return results;
	}

	// ── import ────────────────────────────────────────────────────────────────

	/** A free document id for content that is not already the stored one:
	 *  the derived id, or a longer prefix when a replaced document (whose id
	 *  outlived its content) happens to sit on it. */
	function freshId(ids: { pdfSha256?: string; contentHash: string }): string {
		const full = ids.pdfSha256 ?? ids.contentHash;
		let id = documentIdFor(ids);
		for (let len = 16; store.getMeta(id) && len <= full.length; len += 4) id = `doc_${full.slice(0, len)}`;
		return id;
	}

	function buildMeta(args: {
		id: string;
		markdown: string;
		description: DocumentDescription;
		filename: string;
		origin: DocumentMeta["origin"];
		pdfSha256?: string;
		pages?: number;
		ocr?: DocumentMeta["ocr"];
	}): DocumentMeta {
		const prior = store.getMeta(args.id);
		const fp = fingerprint(args.markdown);
		const stamp = now();
		return {
			id: args.id,
			contentHash: fp.contentHash,
			...(args.pdfSha256 ? { pdfSha256: args.pdfSha256 } : {}),
			minhash: fp.minhash,
			title: args.description.title,
			summary: args.description.summary,
			topics: normalizeTopics(args.description.topics),
			filenames: [...new Set([...(prior?.filenames ?? []), args.filename])],
			importedAt: prior?.importedAt ?? stamp,
			updatedAt: stamp,
			...(args.pages !== undefined ? { pages: args.pages } : {}),
			origin: args.origin,
			...(args.ocr ? { ocr: args.ocr } : {}),
			sections: fp.sections,
			sourceId: args.id,
		};
	}

	/** Contain every failure of the background tail into a completion. */
	function settle(work: () => Promise<ImportCompletion>, label: string): Promise<ImportCompletion> {
		return work().catch((err: unknown) => {
			const completion = failureOf(err);
			// Side-channel law: the learner hears about a failed background import by push.
			void Promise.resolve(deps.notify({ kind: "extraction", label, status: "error" })).catch(() => {});
			return completion;
		});
	}

	function failureOf(err: unknown): ImportCompletion {
		if (err instanceof ModelsNotConfiguredError) {
			return { ok: false, outcome: "failed", error: err.envelope.error, code: "models_not_configured", missing: err.envelope.missing };
		}
		if (err instanceof ProviderKeyMissingError) {
			return { ok: false, outcome: "failed", error: err.envelope.error, code: "provider_key_missing", provider: err.envelope.provider, slots: err.envelope.slots };
		}
		if (err instanceof NotesImportError) {
			return { ok: false, outcome: err.outcome, stats: err.partialStats, error: err.message };
		}
		if (err instanceof Error && err.name === "AbortError") return { ok: false, outcome: "aborted", error: "Scanning was stopped." };
		if (err instanceof OcrError) return { ok: false, outcome: "failed", error: err.message, code: err.code };
		return { ok: false, outcome: "failed", error: err instanceof Error ? err.message : String(err) };
	}

	async function extract(meta: DocumentMeta, name: string, markdown: string): Promise<ImportCompletion> {
		const stats = await deps.importNotes({
			id: meta.id,
			title: meta.title,
			filePath: name,
			text: parseFrontMatter(markdown).body,
		});
		return { ok: true, outcome: "completed", docId: meta.id, stats };
	}

	async function describeText(markdown: string, name: string): Promise<DocumentDescription> {
		const known = describedByFrontMatter(parseFrontMatter(markdown).data);
		if (known) return known;
		return deps.describe(normalizeText(markdown, { keepCase: true }));
	}

	/** The id a matched file lands on: replace (and an exact duplicate, which
	 *  is the same content by definition) keeps the stored document's id and
	 *  with it its graph source; anything else mints one from the content. */
	function targetOf(verdict: DuplicateVerdict, decision: DocumentDecision | undefined): string | undefined {
		return verdict.of && (decision === "replace" || verdict.status === "duplicate") ? verdict.of.id : undefined;
	}

	async function importMarkdown(file: IncomingFile, index: number, verdict: DuplicateVerdict, decision: DocumentDecision | undefined): Promise<ImportTicket> {
		const markdown = decodeText(file.bytes);
		if (markdown === null || normalizeText(markdown) === "") {
			return { index, name: file.name, outcome: "failed", error: markdown === null ? "Not a text or PDF file." : "The file is empty." };
		}
		const fp = fingerprint(markdown);
		const id = targetOf(verdict, decision) ?? freshId({ contentHash: fp.contentHash });
		const description = await describeText(markdown, file.name);
		const meta = buildMeta({ id, markdown, description, filename: file.name, origin: "markdown" });
		store.save(meta, markdown);
		const completion = settle(() => extract(meta, file.name, markdown), meta.title);
		return { index, name: file.name, outcome: "started", docId: meta.id, title: meta.title, completion };
	}

	async function importPdf(file: IncomingFile, index: number, verdict: DuplicateVerdict, decision: DocumentDecision | undefined): Promise<ImportTicket> {
		if (!ocr.configured()) {
			throw new OcrError("ocr_not_configured", "PDF import needs the OCR service, and OCR_URL is not set on this server.");
		}
		const pdfSha256 = sha256Hex(file.bytes);
		const known = await knownScan(pdfSha256);
		if (!known) ocr.assertCanScan();
		const explicit = decision !== undefined;
		const targetId = targetOf(verdict, decision);
		const rowId = `scan_${pdfSha256.slice(0, 12)}`;
		const controller = new AbortController();
		const completion = settle(async () => {
			let markdown: string;
			let job: string;
			let strategy = "";
			let costUsd = 0;
			let pages: number | undefined;
			if (known) {
				markdown = await ocr.markdown(known.job, known.markdown);
				job = known.job;
				costUsd = known.cost_usd;
				pages = known.pages;
			} else {
				const run = await scan(file, rowId, controller);
				({ markdown, job, strategy, costUsd, pages } = run);
			}
			const fm = parseFrontMatter(markdown);
			// The scan may itself be a duplicate of something already in the
			// library (same text, different bytes): skip unless the learner
			// explicitly chose replace / import as new.
			const textVerdict = classify(store.listMetas().filter((m) => m.id !== targetId), candidateOf(markdown, pdfSha256));
			if (textVerdict.status !== "new" && textVerdict.of && !explicit) {
				console.info(`[documents] scan of ${file.name} duplicates ${textVerdict.of.id} - not stored`);
				return { ok: true, outcome: "skipped", duplicateOf: { id: textVerdict.of.id, title: textVerdict.of.title } } satisfies ImportCompletion;
			}
			const description = describedByFrontMatter(fm.data) ?? (await deps.describe(normalizeText(markdown, { keepCase: true })));
			const id = targetId ?? freshId({ pdfSha256, contentHash: fingerprint(markdown).contentHash });
			const meta = buildMeta({
				id,
				markdown,
				description,
				filename: file.name,
				origin: "pdf",
				pdfSha256,
				pages: pages ?? (typeof fm.data.pages === "number" ? fm.data.pages : undefined),
				ocr: { job, strategy, costUsd },
			});
			store.save(meta, markdown);
			return extract(meta, file.name, markdown);
		}, stem(file.name));
		return { index, name: file.name, outcome: "started", docId: targetId ?? documentIdFor({ pdfSha256 }), title: stem(file.name), completion };
	}

	/** Run one OCR job to completion, mirroring progress into the scan row. */
	async function scan(file: IncomingFile, rowId: string, controller: AbortController) {
		const row: RunningScan = { id: rowId, title: `Scanning ${stem(file.name)}`, startedAt: Date.now(), controller };
		scans().set(rowId, row);
		emit("activity-changed", {});
		try {
			const job = await ocr.start([{ name: file.name, bytes: file.bytes }]);
			for (;;) {
				controller.signal.throwIfAborted();
				const status = await ocr.job(job);
				const f = status.files[0];
				if (f) {
					const progress = f.pages > 0 ? ` · ${f.done_pages}/${f.pages} pages` : "";
					const title = `Scanning ${f.title ?? stem(file.name)}${progress}`;
					if (title !== row.title) {
						row.title = title;
						emit("activity-changed", {});
					}
				}
				if (status.status === "failed" || f?.status === "failed") {
					throw new OcrError("ocr_failed", `Scanning ${file.name} failed${f?.error ? `: ${f.error}` : "."}`);
				}
				if (status.status === "done" && f?.status === "done" && f.markdown) {
					return {
						markdown: await ocr.markdown(job, f.markdown),
						job,
						strategy: status.strategy,
						costUsd: f.cost_usd,
						pages: f.pages,
					};
				}
				await new Promise<void>((resolve, reject) => {
					const t = setTimeout(resolve, pollMs);
					controller.signal.addEventListener("abort", () => { clearTimeout(t); reject(controller.signal.reason); }, { once: true });
				});
			}
		} finally {
			scans().delete(rowId);
			emit("activity-changed", {});
		}
	}

	/**
	 * Apply the learner's decisions. `decisions[i]` belongs to `files[i]`;
	 * the server re-classifies every file (it never trusts the client's
	 * check), and the default for a duplicate or similar file is skip. New
	 * files import regardless.
	 */
	async function importFiles(
		files: IncomingFile[],
		decisions: (DocumentDecision | undefined)[] = [],
		opts: { markdownOnly?: boolean } = {},
	): Promise<ImportTicket[]> {
		const tickets: ImportTicket[] = [];
		for (const [index, file] of files.entries()) {
			try {
				// Fresh per file: two identical files in one batch are one document.
				const metas = store.listMetas();
				if (opts.markdownOnly && isPdf(file.bytes)) {
					tickets.push({ index, name: file.name, outcome: "failed", error: "PDF files are added through Add documents." });
					continue;
				}
				const checked = await checkOne(file, index, metas);
				if (checked.error) {
					tickets.push({ index, name: file.name, outcome: "failed", error: checked.error });
					continue;
				}
				// A decision only exists for a file that matched something.
				const decision: DocumentDecision | undefined = checked.verdict.status === "new" ? undefined : (decisions[index] ?? "skip");
				if (decision === "skip") {
					tickets.push({ index, name: file.name, outcome: "skipped", ...(checked.verdict.of ? { docId: checked.verdict.of.id, title: checked.verdict.of.title } : {}) });
					continue;
				}
				tickets.push(
					checked.kind === "pdf"
						? await importPdf(file, index, checked.verdict, decision)
						: await importMarkdown(file, index, checked.verdict, decision),
				);
			} catch (err) {
				const f = failureOf(err);
				tickets.push({ index, name: file.name, outcome: "failed", error: f.error, code: f.code, missing: f.missing, provider: f.provider, slots: f.slots });
			}
		}
		return tickets;
	}

	return {
		check,
		importFiles,
		list: (): DocumentSummary[] => store.listMetas().map(asSummary),
		get: (id: string): { meta: DocumentSummary; markdown: string } | null => {
			const meta = store.getMeta(id);
			const markdown = store.readMarkdown(id);
			return meta && markdown !== null ? { meta: asSummary(meta), markdown } : null;
		},
		/** The sidecar's scan estimate for the PDFs among `files`; null when there are none. */
		estimate: (files: IncomingFile[]) => {
			const pdfs = files.filter((f) => isPdf(f.bytes));
			return pdfs.length === 0 ? Promise.resolve(null) : ocr.estimate(pdfs);
		},
	};
}

export type DocumentService = ReturnType<typeof createDocumentService>;
