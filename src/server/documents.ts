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
import type { DocumentDecision, DocumentMeta, DocumentSummary, DuplicateVerdict, LegacyImport } from "../core/contracts/documents.ts";
import type { DocumentStore, GraphStore } from "../core/ports.ts";
import { canonicalizeAndStoreTopics } from "../core/topics.ts";
import { emit } from "../core/events.ts";
import {
	classify,
	describedByFrontMatter,
	documentIdFor,
	fingerprint,
	legacySourceIds,
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
	/** A filename match whose old import produced no nodes (raw-PDF text
	 *  imports): offered as new, with a hint. */
	legacyEmpty?: { sourceId: string; importedAt: string };
}

export interface ImportCompletion {
	ok: boolean;
	docId?: string;
	stats?: EmissionStats;
	/** Extraction ended short of complete (NotesImportError.outcome). */
	outcome?: "completed" | "failed" | "partial" | "aborted" | "busy" | "skipped";
	/** The scanned text turned out to duplicate another document. */
	duplicateOf?: { id: string; title: string };
	/** An old graph source adopted the document (no extraction ran). */
	attached?: boolean;
	/** Nodes the topic tagging pass filed (attach only). */
	tagged?: number;
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
	/** The graph's source records + ledgers (PR H): legacy detection, the
	 *  topic alias table, the source label. Absent = no graph features. */
	graph?: Pick<
		GraphStore,
		"readSources" | "upsertSource" | "readNodes" | "readTopics" | "readTopicAliases" | "writeTopicAliases"
	>;
	/** Cheap-slot topic canonicalisation (new -> canonical). Best effort. */
	canonicalize?(newTopics: readonly string[], existing: readonly string[], signal?: AbortSignal): Promise<Record<string, string>>;
	/** Cheap-slot topic tagging of an adopted source's nodes. */
	tagNodes?(
		topics: readonly string[],
		nodes: readonly { id: string; name: string; statement: string }[],
		signal?: AbortSignal,
	): Promise<{ nodeId: string; topics: string[] }[]>;
	/** The merger's topic entry point (the pipeline's applyTopicRows). */
	applyTopicRows?(input: {
		sourceId: string;
		label: string;
		assignments: ReadonlyArray<{ nodeId: string; topics: readonly string[] }>;
	}): Promise<number>;
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

/** Show a background job as a dock row (same registry as PDF scans, so the
 *  dock lists it and abortScan stops it). The row ends when `run` settles. */
export async function withActivityRow<T>(
	id: string,
	title: string,
	run: (setTitle: (title: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const row: RunningScan = { id, title, startedAt: Date.now(), controller };
	scans().set(id, row);
	emit("activity-changed", {});
	try {
		return await run((next) => {
			if (next === row.title) return;
			row.title = next;
			emit("activity-changed", {});
		}, controller.signal);
	} finally {
		scans().delete(id);
		emit("activity-changed", {});
	}
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

	/** An earlier import of this file name in the graph (PR H): a legacy
	 *  source - id = "src_" + sha256(filename) - that has no document yet.
	 *  With nodes it is "legacy" (attach, no re-extraction); with none (the
	 *  old raw-PDF text imports) it is only a hint, and the file is new. */
	function legacyOf(name: string, metas: DocumentMeta[]): { legacy?: LegacyImport; empty?: { sourceId: string; importedAt: string } } {
		if (!deps.graph) return {};
		const ids = legacySourceIds(name);
		const attached = new Set(metas.map((m) => m.sourceId));
		const source = deps.graph.readSources().find((s) => ids.includes(s.id) && !attached.has(s.id));
		if (!source) return {};
		const nodeCount = new Set(deps.graph.readNodes().filter((n) => n.provenance.some((pt) => pt.chatId === source.id)).map((n) => n.id)).size;
		return nodeCount > 0
			? { legacy: { sourceId: source.id, importedAt: source.importedAt, nodeCount } }
			: { empty: { sourceId: source.id, importedAt: source.importedAt } };
	}

	async function checkOne(file: IncomingFile, index: number, metas: DocumentMeta[]): Promise<CheckResult> {
		const result = await classifyOne(file, index, metas);
		if (result.error || result.verdict.status !== "new") return result;
		const { legacy, empty } = legacyOf(file.name, metas);
		if (legacy) return { ...result, verdict: { status: "legacy", legacy } };
		return empty ? { ...result, legacyEmpty: empty } : result;
	}

	async function classifyOne(file: IncomingFile, index: number, metas: DocumentMeta[]): Promise<CheckResult> {
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
		sourceId?: string;
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
			// A replaced document keeps the graph source it already feeds (and an
			// adopted old import keeps its legacy id); anything else starts at its id.
			sourceId: args.sourceId ?? prior?.sourceId ?? args.id,
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
		const body = parseFrontMatter(markdown).body;
		// The sections index the full stored markdown; the extractor reads the
		// body without its front matter, so shift the offsets to match.
		const shift = markdown.length - body.length;
		const stats = await deps.importNotes({
			id: meta.sourceId,
			title: meta.title,
			filePath: name,
			text: body,
			topics: meta.topics,
			sections: meta.sections.map((s) => ({ ...s, start: s.start - shift, end: s.end - shift })),
		});
		return { ok: true, outcome: "completed", docId: meta.id, stats };
	}

	/** Map a new document's topics onto the library's existing ones (cheap
	 *  slot, across languages) and persist the mapping as the alias table
	 *  BEFORE extraction - the merger applies it deterministically. Best
	 *  effort: with no model or on any failure the topics stay as they are. */
	async function canonicalizeTopics(topics: string[], signal?: AbortSignal): Promise<string[]> {
		const graph = deps.graph;
		if (!graph || topics.length === 0) return topics;
		return canonicalizeAndStoreTopics(
			graph,
			topics,
			deps.canonicalize,
			store.listMetas().flatMap((m) => m.topics),
			signal,
		);
	}

	/** ADOPT AN OLD IMPORT (PR H): the document is stored against the legacy
	 *  graph source (meta.sourceId) and nothing is re-extracted. The source
	 *  record keeps its usage log but takes the document's title as its
	 *  label, and the cheap tagging pass files the source's existing nodes
	 *  under the document's topics - rows that reach the ledger only through
	 *  the merger (applyTopicRows). */
	async function adopt(meta: DocumentMeta): Promise<ImportCompletion> {
		const graph = deps.graph;
		let tagged = 0;
		if (graph) {
			const prior = graph.readSources().find((s) => s.id === meta.sourceId);
			graph.upsertSource({ id: meta.sourceId, filePath: meta.title, importedAt: prior?.importedAt ?? meta.importedAt });
			if (deps.tagNodes && deps.applyTopicRows && meta.topics.length > 0) {
				const seen = new Set<string>();
				const nodes = graph
					.readNodes()
					.filter((n) => n.provenance.some((pt) => pt.chatId === meta.sourceId) && !seen.has(n.id) && !!seen.add(n.id))
					.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
				const assignments = await deps.tagNodes(meta.topics, nodes);
				if (assignments.length > 0) {
					tagged = await deps.applyTopicRows({ sourceId: meta.sourceId, label: meta.title, assignments });
				}
			}
		}
		return { ok: true, outcome: "completed", docId: meta.id, attached: true, tagged };
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

	async function importMarkdown(file: IncomingFile, index: number, verdict: DuplicateVerdict, decision: DocumentDecision | undefined, attachTo?: string): Promise<ImportTicket> {
		const markdown = decodeText(file.bytes);
		if (markdown === null || normalizeText(markdown) === "") {
			return { index, name: file.name, outcome: "failed", error: markdown === null ? "Not a text or PDF file." : "The file is empty." };
		}
		const fp = fingerprint(markdown);
		const id = targetOf(verdict, decision) ?? freshId({ contentHash: fp.contentHash });
		const described = await describeText(markdown, file.name);
		const description = { ...described, topics: await canonicalizeTopics(normalizeTopics(described.topics)) };
		const meta = buildMeta({ id, markdown, description, filename: file.name, origin: "markdown", sourceId: attachTo });
		store.save(meta, markdown);
		const completion = settle(() => (attachTo ? adopt(meta) : extract(meta, file.name, markdown)), meta.title);
		return { index, name: file.name, outcome: "started", docId: meta.id, title: meta.title, completion };
	}

	async function importPdf(file: IncomingFile, index: number, verdict: DuplicateVerdict, decision: DocumentDecision | undefined, attachTo?: string): Promise<ImportTicket> {
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
			const described = describedByFrontMatter(fm.data) ?? (await deps.describe(normalizeText(markdown, { keepCase: true })));
			const description = { ...described, topics: await canonicalizeTopics(normalizeTopics(described.topics), controller.signal) };
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
				sourceId: attachTo,
			});
			store.save(meta, markdown);
			return attachTo ? adopt(meta) : extract(meta, file.name, markdown);
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
				// A decision only exists for a file that matched something. An old
				// import (legacy) defaults to attach; everything else to skip.
				const legacy = checked.verdict.legacy;
				const asked = decisions[index] ?? (legacy ? "attach" : "skip");
				const decision: DocumentDecision | undefined =
					checked.verdict.status === "new" ? undefined : asked === "attach" && !legacy ? "skip" : asked;
				const attachTo = legacy && decision === "attach" ? legacy.sourceId : undefined;
				if (decision === "skip") {
					tickets.push({ index, name: file.name, outcome: "skipped", ...(checked.verdict.of ? { docId: checked.verdict.of.id, title: checked.verdict.of.title } : {}) });
					continue;
				}
				tickets.push(
					checked.kind === "pdf"
						? await importPdf(file, index, checked.verdict, decision, attachTo)
						: await importMarkdown(file, index, checked.verdict, decision, attachTo),
				);
			} catch (err) {
				const f = failureOf(err);
				tickets.push({ index, name: file.name, outcome: "failed", error: f.error, code: f.code, missing: f.missing, provider: f.provider, slots: f.slots });
			}
		}
		return tickets;
	}

	/** RE-DESCRIBE (maintenance): regenerate title, summary and topics from
	 *  the stored CONTENT - for documents whose front matter carried only a
	 *  filename-derived title (early OCR runs). Nothing is re-extracted: the
	 *  graph source takes the new title, and a source whose nodes have no
	 *  topics yet gets the adopt path's tagging pass. */
	async function redescribe(id: string): Promise<ImportCompletion> {
		const meta = store.getMeta(id);
		const markdown = store.readMarkdown(id);
		if (!meta || markdown === null) return { ok: false, outcome: "failed", error: "No such document" };
		return settle(async () => {
			const described = await deps.describe(normalizeText(markdown, { keepCase: true }));
			const topics = await canonicalizeTopics(normalizeTopics(described.topics));
			const next: DocumentMeta = { ...meta, title: described.title, summary: described.summary, topics, updatedAt: new Date().toISOString() };
			store.save(next, markdown);
			const graph = deps.graph;
			if (graph && !graph.readTopics().some((row) => row.sourceId === next.sourceId)) return adopt(next);
			if (graph) {
				const prior = graph.readSources().find((s) => s.id === next.sourceId);
				graph.upsertSource({ id: next.sourceId, filePath: next.title, importedAt: prior?.importedAt ?? next.importedAt });
			}
			return { ok: true, outcome: "completed", docId: id };
		}, meta.title);
	}

	return {
		check,
		importFiles,
		redescribe,
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
