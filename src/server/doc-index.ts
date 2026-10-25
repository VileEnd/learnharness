/**
 * The document search index (PR I): hybrid retrieval over the library.
 *
 * Built IN MEMORY from the DocumentStore on first use (BM25 over retrieval
 * units, core/doc-search.ts) and kept current through indexDocument() /
 * removeDocument(), which the library's store wrapper (server/library.ts)
 * calls after every save. Embeddings are the optional second leg:
 *
 *   - vectors come from OpenRouter /api/v1/embeddings (BYOK key, model from
 *     the documents.embeddingModel setting) and are PERSISTED through the
 *     DocumentStore port (vectors.f32 + chunks.json) - this module never
 *     writes files, the store stays the single writer;
 *   - a background backfill embeds documents that lack vectors for the
 *     current model (new import, model change, key added later). It shows as
 *     one abortable activity-dock row, and a failure is contained: it logs,
 *     backs off for ten minutes and leaves those documents keyword-only;
 *   - by default the backfill goes through the OpenRouter BATCH API (about
 *     half price, results within minutes to a day): the units of every
 *     document lacking vectors become one batch of `/v1/embeddings` requests
 *     (ONE text each - Vertex, which runs Gemini batches, rejects multi-input
 *     embedding requests; custom_id `${docId}~${offset}`) submitted two
 *     minutes after the last change; pending batches persist through the
 *     store (pending-batches.json) so a restart resumes polling (once a
 *     minute), and a finished batch is read, written as vectors and DELETED
 *     remotely. Vectors are stored under the BASE model id, queries use the
 *     sync model;
 *   - a search NEVER waits for that work. Only the query itself is embedded,
 *     under a short timeout; if that fails the result is keyword-only and
 *     says so (`mode: "keyword"` + `note`).
 *
 * Brute-force cosine over the in-memory vectors is plenty at this scale
 * (thousands of units). Ranking is Reciprocal Rank Fusion of the BM25 and
 * the cosine lists. The embedder is an injected seam, so tests never touch
 * the network.
 */

import { emit } from "../core/events.ts";
import {
	Bm25,
	chunkDocument,
	cosine,
	documentMatches,
	indexText,
	rrf,
	snippetAround,
	tokenize,
	topicMatches,
	type ChunkUnit,
} from "../core/doc-search.ts";
import type {
	DocSearchHit,
	DocSearchQuery,
	DocSearchResult,
} from "../core/doc-search.ts";
import type { DocumentMeta, PendingBatch } from "../core/contracts/documents.ts";
import type { GraphNode } from "../core/contracts/graph.ts";
import { canonicalTopics, topicsByNode } from "../core/topics.ts";
import { conceptPaths, documentPaths, sectionPath } from "../core/okf.ts";
import type { ConceptVectorStore, DocumentStore, GraphStore } from "../core/ports.ts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { LEDGER_FILES } from "../../config.ts";
import { keyValue } from "./keys.ts";
import { graphToolsEnabled } from "../core/settings-resolution.ts";
import { effectiveSettings, stores } from "./stores.ts";

// ─── the embedding seam ──────────────────────────────────────────────────────

export interface Embedder {
	model: string;
	/** One vector per text, in order. Throws on any failure. */
	embed(texts: string[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Float32Array[]>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** POST https://openrouter.ai/api/v1/embeddings {model, input: string[]} ->
 *  {data: [{index, embedding: number[]}]}. */
/** Transient provider answers worth another try (rate limits, overload). */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Wait before retry `attempt` (0-based): the provider's Retry-After when it
 *  sends one, else exponential backoff with jitter, capped at 30s. */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
	const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
	return Math.min(1000 * 2 ** attempt, 30_000) * (0.75 + Math.random() * 0.5);
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason);
		}, { once: true });
	});

export function openRouterEmbedder(apiKey: string, model: string, fetchFn: FetchLike = fetch, maxRetries = 6): Embedder {
	return {
		model,
		async embed(texts, opts = {}) {
			// A large library sends many batches back to back; the embedding
			// providers rate-limit bursts (429). Transient failures retry with
			// backoff instead of failing the whole document.
			let resp: Response;
			for (let attempt = 0; ; attempt++) {
				const signals = [AbortSignal.timeout(opts.timeoutMs ?? 60_000)];
				if (opts.signal) signals.push(opts.signal);
				try {
					resp = await fetchFn("https://openrouter.ai/api/v1/embeddings", {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
						body: JSON.stringify({ model, input: texts, encoding_format: "float" }),
						signal: AbortSignal.any(signals),
					});
				} catch (err) {
					if (opts.signal?.aborted || attempt >= maxRetries) throw err;
					await sleep(retryDelayMs(attempt, null), opts.signal);
					continue;
				}
				if (resp.ok || !RETRYABLE.has(resp.status) || attempt >= maxRetries) break;
				await resp.text().catch(() => "");
				await sleep(retryDelayMs(attempt, resp.headers.get("retry-after")), opts.signal);
			}
			if (!resp.ok) throw new Error(`OpenRouter embeddings ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
			const body = (await resp.json()) as { data?: { index?: number; embedding?: number[] }[] };
			const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r.embedding) || r.embedding.length === 0)) {
				throw new Error(`OpenRouter embeddings returned ${rows.length} vectors for ${texts.length} texts`);
			}
			const dims = rows[0]!.embedding!.length;
			if (rows.some((r) => r.embedding!.length !== dims)) throw new Error("OpenRouter embeddings returned mixed dimensions");
			return rows.map((r) => Float32Array.from(r.embedding!));
		},
	};
}

// ─── the Batch API seam ──────────────────────────────────────────────────────

/** One request of an embeddings batch: `input` is an array of strings and the
 *  response holds one embedding per string, ordered by `index`. */
export interface BatchRequest {
	custom_id: string;
	body: { input: string; encoding_format: "float" };
}

/** GET /api/v1/batches/{id}. `results` is null until the batch is terminal;
 *  each result has either a `response` or an `error`. */
export interface BatchState {
	status: string;
	results: BatchResult[] | null;
	error: { message?: string } | null;
	usage: { cost?: number } | null;
}
export interface BatchResult {
	custom_id: string;
	response: { status_code?: number; body?: { data?: { index?: number; embedding?: number[] }[] } } | null;
	error: { message?: string } | null;
}

/** A non-2xx answer from the batch endpoints (413 split, 402 balance, 429 wait). */
export class BatchHttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface BatchClient {
	/** The BASE model id; the client submits it as `${model}:batch`. */
	model: string;
	/** POST /api/v1/batches -> the batch id. Throws BatchHttpError. */
	submit(requests: BatchRequest[]): Promise<string>;
	get(batchId: string): Promise<BatchState>;
	/** DELETE /api/v1/batches/{id} (terminal batches only); 404 counts as done. */
	remove(batchId: string): Promise<void>;
}

const BATCHES = "https://openrouter.ai/api/v1/batches";

export function openRouterBatchClient(apiKey: string, model: string, fetchFn: FetchLike = fetch): BatchClient {
	const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
	const call = (url: string, init: RequestInit, timeoutMs: number): Promise<Response> =>
		fetchFn(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
	async function fail(resp: Response, what: string): Promise<never> {
		const text = await resp.text().catch(() => "");
		let message = text.slice(0, 200);
		try {
			message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
		} catch {
			// not JSON: keep the raw text
		}
		throw new BatchHttpError(resp.status, `OpenRouter batch ${what} ${resp.status}: ${message}`);
	}
	return {
		model,
		async submit(requests) {
			// endpoint and model go BEFORE requests: OpenRouter reads the body as a stream.
			const resp = await call(
				BATCHES,
				{ method: "POST", body: JSON.stringify({ endpoint: "/v1/embeddings", model: `${model}:batch`, requests }) },
				120_000,
			);
			if (!resp.ok) return fail(resp, "submit");
			const id = ((await resp.json()) as { id?: unknown }).id;
			if (typeof id !== "string" || id === "") throw new Error("OpenRouter batch submit returned no id");
			return id;
		},
		async get(batchId) {
			const resp = await call(`${BATCHES}/${encodeURIComponent(batchId)}`, { method: "GET" }, 120_000);
			if (!resp.ok) return fail(resp, "poll");
			const b = (await resp.json()) as Partial<BatchState>;
			return {
				status: String(b.status ?? ""),
				results: Array.isArray(b.results) ? b.results : null,
				error: b.error ?? null,
				usage: b.usage ?? null,
			};
		},
		async remove(batchId) {
			const resp = await call(`${BATCHES}/${encodeURIComponent(batchId)}`, { method: "DELETE" }, 60_000);
			if (!resp.ok && resp.status !== 404) await fail(resp, "delete");
			await resp.text().catch(() => "");
		},
	};
}

/** Texts per request of a batch: exactly one. Verified live 2026-10-25:
 *  Gemini embedding batches run on Vertex, which fails the whole batch with
 *  "Vertex embeddings accept one input per line" for multi-input requests. */
export const BATCH_INPUTS = 1;
/** Per-batch caps, well under OpenRouter's documented 200 MB body limit. */
const BATCH_MAX_REQUESTS = 5000;
const BATCH_MAX_BYTES = 50 * 1024 * 1024;

export interface BatchDoc {
	id: string;
	contentHash: string;
	units: number;
	requests: BatchRequest[];
}

/** A document's units as one request per text; custom_id is
 *  `${docId}~${offset}` with offset = the unit's index. */
export function buildBatchRequests(docId: string, texts: string[]): BatchRequest[] {
	return texts.map((input, offset) => ({ custom_id: `${docId}~${offset}`, body: { input, encoding_format: "float" } }));
}

/** Group whole documents into batches under the request and byte caps (a
 *  document never spans two batches; one over the caps alone gets its own). */
export function packBatches(docs: BatchDoc[]): BatchDoc[][] {
	const groups: BatchDoc[][] = [];
	let cur: BatchDoc[] = [];
	let count = 0;
	let bytes = 0;
	for (const d of docs) {
		const size = d.requests.reduce((n, r) => n + JSON.stringify(r).length, 0);
		if (cur.length > 0 && (count + d.requests.length > BATCH_MAX_REQUESTS || bytes + size > BATCH_MAX_BYTES)) {
			groups.push(cur);
			cur = [];
			count = 0;
			bytes = 0;
		}
		cur.push(d);
		count += d.requests.length;
		bytes += size;
	}
	if (cur.length > 0) groups.push(cur);
	return groups;
}

function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (const x of v) n += x * x;
	n = Math.sqrt(n) || 1;
	return v.map((x) => x / n);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const clock = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
	});
	return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

// ─── the activity row (shares the dock's "scan" registry) ────────────────────

// The dock lists and aborts rows of this registry (documents.ts scanStatuses /
// abortScan, kind "scan"); the index registers its backfill run in the same
// globalThis map instead of growing a second feed.
interface ScanRow {
	id: string;
	title: string;
	startedAt: number;
	controller: AbortController;
}
interface ScanGlobal {
	__lhDocumentScans?: Map<string, ScanRow>;
}
const scanRows = (): Map<string, ScanRow> => ((globalThis as ScanGlobal).__lhDocumentScans ??= new Map());

const BACKFILL_ROW = "index_library";
const BATCH_ROW = "index_library_batch";

// ─── the index ───────────────────────────────────────────────────────────────

export interface DocIndexDeps {
	store: DocumentStore;
	/** The live embedder (key present + current model), or null. Read per call. */
	embedder(): Embedder | null;
	/** The Batch API client (key present + current model), or null. Read per
	 *  call; absent = no batch path. */
	batcher?(): BatchClient | null;
	/** Index through batches (the documents.embeddingBatch setting); false
	 *  keeps the synchronous backfill. Default true when a batcher is wired. */
	batchMode?(): boolean;
	/** Quiet period after the last change before a batch is submitted (2 min). */
	debounceMs?: number;
	/** Gap between polls of a pending batch (1 min). */
	pollIntervalMs?: number;
	/** Run the poll/submit timer (default true); tests drive tick() instead. */
	autoTick?: boolean;
	/** Query-embedding budget before a search falls back to keywords. */
	queryTimeoutMs?: number;
	/** Texts per embeddings request. */
	batchSize?: number;
	/** Pause between a document's embedding batches (default 250ms). */
	batchPauseMs?: number;
	/** Pause after a failed backfill before the next attempt. */
	backoffMs?: number;
	now?: () => number;
	/** The graph, for concepts as search units. Absent = documents only. */
	graphStore?: Pick<GraphStore, "readNodes" | "readTopics" | "readTopicAliases">;
	/** Where concept embeddings persist (data/graph/concept-vectors.*). Absent = in memory only. */
	conceptVectors?: ConceptVectorStore;
	/** The graph gate (graph.enabled / agent.graphTools): off = no concept hits. Default on. */
	conceptsEnabled?(): boolean;
	/** A cheap change stamp of nodes.jsonl (default: its mtime and size). */
	graphStamp?(): string;
}

/** The synthetic index id of a concept: `cpt_<nodeId>`; also its batch id (`cpt_<nodeId>~0`). */
export const CONCEPT_PREFIX = "cpt_";

interface IndexedConcept {
	/** `cpt_<nodeId>`. */
	id: string;
	node: GraphNode;
	/** name + "\n" + statement: what is embedded and keyword-indexed. */
	text: string;
	/** sha256(name + statement). */
	contentHash: string;
	vector?: Float32Array;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function nodesStamp(): string {
	try {
		const st = fs.statSync(LEDGER_FILES.nodes);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "-";
	}
}

interface IndexedChunk {
	id: string;
	docId: string;
	unit: ChunkUnit;
	vector?: Float32Array;
}

interface IndexedDoc {
	id: string;
	/** The graph source the document's extraction wrote under (provenance chatId). */
	sourceId: string;
	title: string;
	topics: string[];
	contentHash: string;
	chunks: IndexedChunk[];
	/** The model the chunk vectors were computed with (absent = none). */
	vectorModel?: string;
}

export const SEARCH_LIMIT = { default: 8, max: 20 } as const;
const CANDIDATES = 50;

export function createDocIndex(deps: DocIndexDeps) {
	const { store } = deps;
	const now = deps.now ?? Date.now;
	const docs = new Map<string, IndexedDoc>();
	const bm25 = new Bm25();
	const chunkById = new Map<string, IndexedChunk>();
	const concepts = new Map<string, IndexedConcept>();
	// The model all concept vectors in memory were computed with (absent = none),
	// the last nodes stamp seen, and whether the persisted vectors were read yet.
	let conceptModel: string | undefined;
	let conceptStamp: string | null = null;
	let conceptVectorsRead = false;
	let built = false;
	let running: Promise<void> | null = null;
	let again = false;
	let backoffUntil = 0;
	// The batch path's state: what is out at OpenRouter, when each batch was
	// last polled, when a document last changed (the debounce clock), and why
	// submitting is paused (shown on the activity row).
	const pending = new Map<string, PendingBatch>();
	const lastPolled = new Map<string, number>();
	let lastChangeAt = 0;
	let note: string | null = null;
	let batchRow: ScanRow | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let tickChain: Promise<void> = Promise.resolve();

	// ── building ──────────────────────────────────────────────────────────────

	function drop(id: string): void {
		const doc = docs.get(id);
		if (!doc) return;
		for (const c of doc.chunks) {
			bm25.remove(c.id);
			chunkById.delete(c.id);
		}
		docs.delete(id);
	}

	function load(meta: DocumentMeta): void {
		drop(meta.id);
		const markdown = store.readMarkdown(meta.id);
		if (markdown === null) return;
		const chunks: IndexedChunk[] = chunkDocument(markdown, meta.sections).map((u, i) => ({
			id: `${meta.id}#${i}`,
			docId: meta.id,
			unit: u,
		}));
		const doc: IndexedDoc = { id: meta.id, sourceId: meta.sourceId, title: meta.title, topics: meta.topics, contentHash: meta.contentHash, chunks };
		// Persisted vectors count only when they describe exactly these units.
		const stored = store.readVectors(meta.id);
		if (
			stored &&
			stored.chunks.length === chunks.length &&
			stored.chunks.every((r, i) => r.start === chunks[i]!.unit.start && r.end === chunks[i]!.unit.end)
		) {
			chunks.forEach((c, i) => (c.vector = stored.vectors.subarray(i * stored.dims, (i + 1) * stored.dims)));
			doc.vectorModel = stored.model;
		}
		for (const c of chunks) {
			bm25.add(c.id, tokenize(indexText(c.unit)));
			chunkById.set(c.id, c);
		}
		docs.set(meta.id, doc);
	}

	/** Bring the concept units up to date with nodes.jsonl (a stat check; the
	 *  ledger is only read when it changed). New or edited concepts are
	 *  keyword-indexed at once and embedded in the background; vectors persisted
	 *  for the same text and model are reused. */
	function refreshConcepts(): void {
		const graph = deps.graphStore;
		if (!graph) return;
		const enabled = deps.conceptsEnabled?.() ?? true;
		const stamp = enabled ? (deps.graphStamp?.() ?? nodesStamp()) : "off";
		if (stamp === conceptStamp) return;
		try {
			const nodes = new Map<string, GraphNode>();
			if (enabled) for (const n of graph.readNodes()) if (!nodes.has(n.id)) nodes.set(n.id, n);
			let stored: ReturnType<ConceptVectorStore["read"]> = null;
			if (enabled && !conceptVectorsRead) {
				conceptVectorsRead = true;
				stored = deps.conceptVectors?.read() ?? null;
				if (stored) conceptModel = stored.model;
			}
			let changed = false;
			for (const [id, c] of [...concepts]) {
				if (nodes.has(c.node.id)) continue;
				bm25.remove(id);
				concepts.delete(id);
				changed = true;
			}
			for (const n of nodes.values()) {
				const id = `${CONCEPT_PREFIX}${n.id}`;
				const hash = sha256(n.name + n.statement);
				const have = concepts.get(id);
				if (have && have.contentHash === hash) {
					have.node = n;
					continue;
				}
				const text = `${n.name}\n${n.statement}`;
				const c: IndexedConcept = { id, node: n, text, contentHash: hash };
				const e = stored?.entries[id];
				if (e && e.contentHash === hash) c.vector = stored!.vectors.slice(e.offset * stored!.dims, (e.offset + 1) * stored!.dims);
				concepts.set(id, c);
				bm25.add(id, tokenize(text));
				changed = true;
			}
			conceptStamp = stamp;
			if (changed) lastChangeAt = now();
		} catch (err) {
			console.warn(`[doc-index] could not read the graph for concept search: ${err instanceof Error ? err.message : err}`);
		}
	}

	function ensureBuilt(): void {
		if (built) return;
		built = true;
		lastChangeAt = now();
		for (const p of store.readPendingBatches()) pending.set(p.batchId, p);
		for (const meta of store.listMetas()) {
			try {
				load(meta);
			} catch (err) {
				console.warn(`[doc-index] skipped ${meta.id}: ${err instanceof Error ? err.message : err}`);
			}
		}
		refreshConcepts();
		kickBackfill();
	}

	/** A document was stored or replaced: (re)index it now, embed it soon. */
	function indexDocument(id: string): void {
		if (!built) return; // the first use builds everything, this document included
		try {
			const meta = store.getMeta(id);
			if (meta) load(meta);
			else drop(id);
		} catch (err) {
			console.warn(`[doc-index] could not index ${id}: ${err instanceof Error ? err.message : err}`);
			return;
		}
		lastChangeAt = now();
		kickBackfill();
	}

	function removeDocument(id: string): void {
		drop(id);
	}

	// ── background embedding ──────────────────────────────────────────────────

	function needsVectors(doc: IndexedDoc, model: string): boolean {
		return doc.chunks.length > 0 && doc.vectorModel !== model;
	}

	function needsConceptVector(c: IndexedConcept, model: string): boolean {
		return !c.vector || conceptModel !== model;
	}

	function conceptsNeeding(model: string): IndexedConcept[] {
		return [...concepts.values()].filter((c) => needsConceptVector(c, model));
	}

	/** Embed every document lacking vectors for the live model. One run at a
	 *  time; a trigger during a run asks for one more pass. */
	function kickBackfill(): void {
		if (deps.batcher && (deps.batchMode?.() ?? true)) return scheduleTick(0);
		if (pending.size > 0) scheduleTick(0); // batches submitted earlier still need reading
		if (running) {
			again = true;
			return;
		}
		const embedder = deps.embedder();
		if (!embedder || now() < backoffUntil) return;
		refreshConcepts();
		if (![...docs.values()].some((d) => needsVectors(d, embedder.model)) && conceptsNeeding(embedder.model).length === 0) return;
		running = backfill()
			.catch((err) => console.warn(`[doc-index] backfill stopped: ${err instanceof Error ? err.message : err}`))
			.finally(() => {
				running = null;
				if (again) {
					again = false;
					kickBackfill();
				}
			});
	}

	async function backfill(): Promise<void> {
		const controller = new AbortController();
		const row: ScanRow = { id: BACKFILL_ROW, title: "Indexing documents", startedAt: Date.now(), controller };
		scanRows().set(BACKFILL_ROW, row);
		emit("activity-changed", {});
		try {
			for (;;) {
				const embedder = deps.embedder(); // re-read: the model or key may have changed mid-run
				if (!embedder) return;
				const todo = [...docs.values()].filter((d) => needsVectors(d, embedder.model));
				const doc = todo[0];
				if (!doc) {
					const cs = conceptsNeeding(embedder.model);
					if (cs.length === 0) return;
					row.title = `Indexing ${cs.length} concept${cs.length === 1 ? "" : "s"}`;
					emit("activity-changed", {});
					try {
						await embedConcepts(cs, embedder, controller.signal);
					} catch (err) {
						backoffUntil = now() + (deps.backoffMs ?? 10 * 60_000);
						console.warn(`[doc-index] embedding concepts failed (keyword search only until retry): ${err instanceof Error ? err.message : err}`);
					}
					return;
				}
				row.title = `Indexing ${doc.title}${todo.length > 1 ? ` · ${todo.length} left` : ""}`;
				emit("activity-changed", {});
				try {
					await embedDocument(doc, embedder, controller.signal);
				} catch (err) {
					backoffUntil = now() + (deps.backoffMs ?? 10 * 60_000);
					console.warn(`[doc-index] embedding ${doc.id} failed (keyword search only until retry): ${err instanceof Error ? err.message : err}`);
					return;
				}
			}
		} finally {
			scanRows().delete(BACKFILL_ROW);
			emit("activity-changed", {});
		}
	}

	async function embedDocument(doc: IndexedDoc, embedder: Embedder, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const size = deps.batchSize ?? 48;
		const texts = doc.chunks.map((c) => indexText(c.unit));
		const vectors: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += size) {
			// Pace the batches of a big document (books have hundreds) so the
			// provider's burst limit is not the thing that stops indexing.
			if (i > 0) await new Promise((r) => setTimeout(r, deps.batchPauseMs ?? 250));
			vectors.push(...(await embedder.embed(texts.slice(i, i + size), { signal })).map(normalize));
		}
		const dims = vectors[0]?.length ?? 0;
		if (dims === 0 || vectors.length !== doc.chunks.length) throw new Error("embedder returned no usable vectors");
		// The document may have been replaced while the requests were out.
		const current = docs.get(doc.id);
		if (!current || current.contentHash !== doc.contentHash) return;
		commitVectors(doc, vectors, embedder.model);
	}

	async function embedConcepts(list: IndexedConcept[], embedder: Embedder, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const size = deps.batchSize ?? 48;
		const vectors: Float32Array[] = [];
		for (let i = 0; i < list.length; i += size) {
			if (i > 0) await new Promise((r) => setTimeout(r, deps.batchPauseMs ?? 250));
			vectors.push(...(await embedder.embed(list.slice(i, i + size).map((c) => c.text), { signal })).map(normalize));
		}
		if (vectors.length !== list.length || vectors.some((v) => v.length === 0)) throw new Error("embedder returned no usable concept vectors");
		commitConcepts(new Map(list.map((c, i) => [c.id, { hash: c.contentHash, vector: vectors[i]! }])), embedder.model);
	}

	/** Make fresh concept vectors live and persist the lot. A vector counts only
	 *  if its concept still has the text it was computed from; a different
	 *  model (or width) replaces what was there. */
	function commitConcepts(fresh: Map<string, { hash: string; vector: Float32Array }>, model: string): number {
		const dims = [...fresh.values()][0]?.vector.length ?? 0;
		if (dims === 0) return 0;
		const heldDims = [...concepts.values()].find((c) => c.vector)?.vector?.length;
		const keep = conceptModel === model && (heldDims === undefined || heldDims === dims);
		if (!keep) for (const c of concepts.values()) c.vector = undefined;
		let written = 0;
		for (const [id, f] of fresh) {
			const c = concepts.get(id);
			if (!c || c.contentHash !== f.hash || f.vector.length !== dims) continue;
			c.vector = f.vector;
			written++;
		}
		conceptModel = model;
		const withVectors = [...concepts.values()].filter((c) => c.vector);
		const flat = new Float32Array(withVectors.length * dims);
		const entries: Record<string, { contentHash: string; offset: number }> = {};
		withVectors.forEach((c, i) => {
			flat.set(c.vector!, i * dims);
			entries[c.id] = { contentHash: c.contentHash, offset: i };
		});
		try {
			deps.conceptVectors?.write({ model, dims, entries, vectors: flat });
		} catch (err) {
			console.warn(`[doc-index] could not save concept vectors: ${err instanceof Error ? err.message : err}`);
		}
		return written;
	}

	/** Persist a document's (normalised) vectors under `model` and make them
	 *  live in memory. The caller has checked the content is still current. */
	function commitVectors(doc: IndexedDoc, vectors: Float32Array[], model: string): void {
		const dims = vectors[0]!.length;
		const flat = new Float32Array(vectors.length * dims);
		vectors.forEach((v, i) => flat.set(v, i * dims));
		store.writeVectors(doc.id, {
			model,
			dims,
			contentHash: doc.contentHash,
			chunks: doc.chunks.map(({ unit: u }) => ({
				sectionId: u.sectionId,
				start: u.start,
				end: u.end,
				...(u.pageFrom !== undefined ? { pageFrom: u.pageFrom, pageTo: u.pageTo } : {}),
			})),
			vectors: flat,
		});
		doc.chunks.forEach((c, i) => (c.vector = flat.subarray(i * dims, (i + 1) * dims)));
		doc.vectorModel = model;
	}

	// ── background embedding through the Batch API ────────────────────────────

	function persist(): void {
		try {
			store.writePendingBatches([...pending.values()]);
		} catch (err) {
			console.warn(`[doc-index] could not save pending batches: ${err instanceof Error ? err.message : err}`);
		}
	}

	function forget(batchId: string): void {
		pending.delete(batchId);
		lastPolled.delete(batchId);
		persist();
	}

	/** Run `tick` soon (replacing a timer already set). */
	function scheduleTick(delayMs: number): void {
		if (deps.autoTick === false) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void tick();
		}, delayMs);
		timer.unref?.();
	}

	/** One pass of the batch state machine: poll every pending batch that is
	 *  due, then submit documents lacking vectors once the library has been
	 *  quiet for the debounce. Passes never overlap and never throw. */
	function tick(): Promise<void> {
		const next = tickChain.then(runTick);
		tickChain = next;
		return next;
	}

	async function runTick(): Promise<void> {
		try {
			ensureBuilt();
			refreshConcepts();
			const batcher = deps.batcher?.() ?? null;
			if (batcher) {
				const pollMs = deps.pollIntervalMs ?? 60_000;
				for (const p of [...pending.values()]) {
					if (now() - (lastPolled.get(p.batchId) ?? -Infinity) < pollMs) continue;
					lastPolled.set(p.batchId, now());
					await pollOne(batcher, p);
				}
				if (deps.batchMode?.() ?? true) await submitDue(batcher);
			}
			syncRow();
			planNext(batcher);
		} catch (err) {
			console.warn(`[doc-index] batch pass failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	function planNext(batcher: BatchClient | null): void {
		if (!batcher) return;
		const pollMs = deps.pollIntervalMs ?? 60_000;
		if (!(deps.batchMode?.() ?? true) && pending.size === 0) return;
		const waiting = pending.size > 0;
		const todo = (deps.batchMode?.() ?? true) && batchTodo(batcher).length > 0;
		if (!waiting && !todo) return;
		const dueIn = Math.max(backoffUntil, lastChangeAt + (deps.debounceMs ?? 120_000)) - now();
		scheduleTick(todo && !waiting ? Math.min(pollMs, Math.max(1000, dueIn)) : pollMs);
	}

	/** Documents and concepts that need vectors and are not already out in a batch. */
	function batchTodo(batcher: BatchClient): BatchDoc[] {
		const inFlight = new Set([...pending.values()].flatMap((p) => Object.keys(p.docs)));
		const todo: BatchDoc[] = [...docs.values()]
			.filter((d) => needsVectors(d, batcher.model) && !inFlight.has(d.id))
			.map((d) => ({
				id: d.id,
				contentHash: d.contentHash,
				units: d.chunks.length,
				requests: buildBatchRequests(d.id, d.chunks.map((c) => indexText(c.unit))),
			}));
		for (const c of conceptsNeeding(batcher.model)) {
			if (inFlight.has(c.id)) continue;
			todo.push({ id: c.id, contentHash: c.contentHash, units: 1, requests: buildBatchRequests(c.id, [c.text]) });
		}
		return todo;
	}

	async function pollOne(batcher: BatchClient, p: PendingBatch): Promise<void> {
		let state: BatchState;
		try {
			state = await batcher.get(p.batchId);
		} catch (err) {
			const status = err instanceof BatchHttpError ? err.status : 0;
			// A batch reads as "not found" for a few seconds right after it is
			// created (seen live) - only a lasting 404 means it is gone.
			if ((status === 404 && now() - p.submittedAt > 10 * 60_000) || status === 410) {
				console.warn(`[doc-index] batch ${p.batchId} no longer exists (${status}); its documents go into the next batch`);
				forget(p.batchId);
			} else {
				if (status === 429) lastPolled.set(p.batchId, now() + (deps.pollIntervalMs ?? 60_000)); // back off a second minute
				console.warn(`[doc-index] polling batch ${p.batchId} failed (will retry): ${err instanceof Error ? err.message : err}`);
			}
			return;
		}
		if (state.status === "completed") {
			if (!state.results) return; // terminal but results not attached yet: next poll
			const written = applyResults(p, batcher.model, state.results);
			console.info(
				`[doc-index] batch ${p.batchId} completed: ${written}/${Object.keys(p.docs).length} entries embedded` +
					(state.usage?.cost !== undefined ? `, cost $${state.usage.cost}` : ""),
			);
		} else if (state.status === "failed" || state.status === "expired" || state.status === "cancelled") {
			console.warn(`[doc-index] batch ${p.batchId} ${state.status}: ${state.error?.message ?? "no reason given"}; retrying in a while`);
			backoffUntil = now() + (deps.backoffMs ?? 10 * 60_000);
		} else {
			return; // validating | in_progress | finalizing
		}
		forget(p.batchId);
		// Privacy: OpenRouter would keep the requests and results for 30 days.
		try {
			await batcher.remove(p.batchId);
		} catch (err) {
			console.warn(`[doc-index] could not delete batch ${p.batchId} at OpenRouter: ${err instanceof Error ? err.message : err}`);
		}
	}

	/** Write the vectors of every document whose requests all succeeded and
	 *  whose text is unchanged; the rest stay unvectored (the next batch picks
	 *  them up). Returns how many documents were written. */
	function applyResults(p: PendingBatch, model: string, results: BatchResult[]): number {
		const parts = new Map<string, Map<number, Float32Array[] | null>>();
		for (const r of results) {
			const cut = r.custom_id.lastIndexOf("~");
			const offset = Number(r.custom_id.slice(cut + 1));
			if (cut < 0 || !Number.isInteger(offset)) continue;
			const rows = [...(r.response?.body?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			const ok = !r.error && r.response?.status_code === 200 && rows.length > 0 && rows.every((x) => Array.isArray(x.embedding) && x.embedding.length > 0);
			const byOffset = parts.get(r.custom_id.slice(0, cut)) ?? new Map<number, Float32Array[] | null>();
			byOffset.set(offset, ok ? rows.map((x) => normalize(Float32Array.from(x.embedding!))) : null);
			parts.set(r.custom_id.slice(0, cut), byOffset);
		}
		if (p.model !== model) return 0; // the embedding model changed while the batch was out
		let written = 0;
		const freshConcepts = new Map<string, { hash: string; vector: Float32Array }>();
		for (const [docId, sent] of Object.entries(p.docs)) {
			if (docId.startsWith(CONCEPT_PREFIX)) {
				const c = concepts.get(docId);
				const part = parts.get(docId)?.get(0);
				if (!c || c.contentHash !== sent.contentHash || sent.units !== 1) continue; // edited or removed while pending
				if (!part || part.length !== 1) {
					console.warn(`[doc-index] batch ${p.batchId}: ${docId} failed; it goes into the next batch`);
					continue;
				}
				freshConcepts.set(docId, { hash: sent.contentHash, vector: part[0]! });
				continue;
			}
			const doc = docs.get(docId);
			if (!doc || doc.contentHash !== sent.contentHash || doc.chunks.length !== sent.units) continue; // replaced or removed while pending
			const byOffset = parts.get(docId);
			const vectors: Float32Array[] = [];
			let complete = !!byOffset;
			for (let offset = 0; complete && offset < sent.units; offset += BATCH_INPUTS) {
				const part = byOffset!.get(offset);
				if (!part || part.length !== Math.min(BATCH_INPUTS, sent.units - offset)) complete = false;
				else vectors.push(...part);
			}
			if (!complete || vectors.some((v) => v.length !== vectors[0]!.length)) {
				console.warn(`[doc-index] batch ${p.batchId}: ${docId} has failed or missing requests; it goes into the next batch`);
				continue;
			}
			commitVectors(doc, vectors, model);
			written++;
		}
		if (freshConcepts.size > 0) written += commitConcepts(freshConcepts, model);
		return written;
	}

	async function submitDue(batcher: BatchClient): Promise<void> {
		if (now() < backoffUntil) return;
		note = null;
		if (now() - lastChangeAt < (deps.debounceMs ?? 120_000)) return;
		for (const group of packBatches(batchTodo(batcher))) if (!(await submitGroup(batcher, group))) return;
	}

	/** Submit one batch; false = stop for now (the reason is logged and shown). */
	async function submitGroup(batcher: BatchClient, group: BatchDoc[]): Promise<boolean> {
		try {
			const batchId = await batcher.submit(group.flatMap((d) => d.requests));
			pending.set(batchId, {
				batchId,
				model: batcher.model,
				submittedAt: now(),
				docs: Object.fromEntries(group.map((d) => [d.id, { contentHash: d.contentHash, units: d.units }])),
			});
			lastPolled.set(batchId, now());
			persist();
			console.info(`[doc-index] submitted batch ${batchId}: ${group.length} documents, ${group.reduce((n, d) => n + d.requests.length, 0)} requests`);
			return true;
		} catch (err) {
			const status = err instanceof BatchHttpError ? err.status : 0;
			const why = err instanceof Error ? err.message : String(err);
			if (status === 413 && group.length > 1) {
				const half = Math.ceil(group.length / 2);
				return (await submitGroup(batcher, group.slice(0, half))) && (await submitGroup(batcher, group.slice(half)));
			}
			if (status === 429) {
				backoffUntil = now() + 60_000;
				note = "rate limited, retrying in a minute";
			} else if (status === 402) {
				backoffUntil = now() + (deps.backoffMs ?? 10 * 60_000);
				note = "OpenRouter balance too low, retrying later";
			} else {
				backoffUntil = now() + (deps.backoffMs ?? 10 * 60_000);
				note = "could not submit, retrying later";
			}
			console.warn(`[doc-index] batch submit failed (keyword search only until retry): ${why}`);
			return false;
		}
	}

	/** The activity-dock row while batches are out (or submitting is paused).
	 *  Abort forgets the pending batches HERE only: OpenRouter has no cancel,
	 *  so they finish remotely unread and expire after 30 days. */
	function syncRow(): void {
		const documents = new Set([...pending.values()].flatMap((p) => Object.keys(p.docs))).size;
		if (pending.size === 0 && note === null) {
			if (batchRow) {
				scanRows().delete(BATCH_ROW);
				batchRow = null;
				emit("activity-changed", {});
			}
			return;
		}
		const title = `Indexing documents (batch) · ${note ?? "waiting for OpenRouter"}${documents > 0 ? ` · ${documents} document${documents === 1 ? "" : "s"}` : ""}`;
		if (!batchRow) {
			const controller = new AbortController();
			controller.signal.addEventListener("abort", () => {
				pending.clear();
				lastPolled.clear();
				persist();
				note = null;
				backoffUntil = now() + (deps.backoffMs ?? 10 * 60_000);
				scanRows().delete(BATCH_ROW);
				batchRow = null;
				emit("activity-changed", {});
			});
			batchRow = { id: BATCH_ROW, title, startedAt: Date.now(), controller };
			scanRows().set(BATCH_ROW, batchRow);
		}
		batchRow.title = title;
		emit("activity-changed", {});
	}

	/** Re-embed the whole library with the current model (settings action). */
	function reindex(): { documents: number; concepts: number } {
		ensureBuilt();
		for (const d of docs.values()) d.vectorModel = undefined;
		conceptModel = undefined;
		for (const c of concepts.values()) c.vector = undefined;
		backoffUntil = 0;
		lastChangeAt = Number.NEGATIVE_INFINITY; // asked for: no debounce
		kickBackfill();
		return { documents: docs.size, concepts: concepts.size };
	}

	// ── search ────────────────────────────────────────────────────────────────

	function candidateDocs(q: DocSearchQuery): IndexedDoc[] {
		return [...docs.values()].filter(
			(d) => (!q.topic || topicMatches(d.topics, q.topic)) && (!q.document || documentMatches(d, q.document)),
		);
	}

	/** Concepts the filters let through. A topic filter matches the concept's
	 *  canonical topics (topics.jsonl + the alias table). A document filter keeps
	 *  only concepts whose provenance points at a matching document: a concept
	 *  that came from a chat, or from another document, is not "in" it. */
	function candidateConcepts(q: DocSearchQuery): IndexedConcept[] {
		if (q.includeConcepts === false) return [];
		let list = [...concepts.values()];
		if (q.document) {
			const wanted = new Set([...docs.values()].filter((d) => documentMatches(d, q.document!)).map((d) => d.sourceId));
			list = list.filter((c) => c.node.provenance.some((p) => wanted.has(p.chatId)));
		}
		if (q.topic && list.length > 0) {
			const byNode = new Map<string, string[]>();
			try {
				const aliases = deps.graphStore?.readTopicAliases() ?? {};
				for (const [id, topics] of topicsByNode(deps.graphStore?.readTopics() ?? [])) byNode.set(id, canonicalTopics(topics, aliases));
			} catch {
				// unreadable topics: nothing matches the topic filter
			}
			list = list.filter((c) => topicMatches(byNode.get(c.node.id) ?? [], q.topic!));
		}
		return list;
	}

	async function search(input: DocSearchQuery & { query: string }): Promise<DocSearchResult> {
		ensureBuilt();
		refreshConcepts();
		kickBackfill(); // a model change or a new key is noticed here, never waited for
		const query = input.query.trim();
		const limit = Math.min(SEARCH_LIMIT.max, Math.max(1, Math.floor(input.limit ?? SEARCH_LIMIT.default)));
		const candidates = candidateDocs(input);
		const conceptCandidates = candidateConcepts(input);
		const empty = (note: string): DocSearchResult => ({ mode: "keyword", query, hits: [], note });
		if (query === "") return empty("Empty query.");
		if (docs.size === 0 && concepts.size === 0) return empty("The library has no documents yet.");
		if (candidates.length === 0 && conceptCandidates.length === 0) {
			return empty("Nothing matches that topic or document filter. Browse documents/ and topics/ in the library for what exists.");
		}

		const allowed = new Set(candidates.map((d) => d.id));
		const allowedConcepts = new Set(conceptCandidates.map((c) => c.id));
		const tokens = tokenize(query);
		const keyword = bm25
			.search(tokens, (id) => (id.startsWith(CONCEPT_PREFIX) ? allowedConcepts.has(id) : allowed.has(chunkById.get(id)!.docId)))
			.slice(0, CANDIDATES);

		// The vector leg: only entries embedded with the live model take part.
		let mode: DocSearchResult["mode"] = "keyword";
		let note: string | undefined;
		let semantic: string[] = [];
		const embedder = deps.embedder();
		const embedded = embedder ? candidates.filter((d) => d.vectorModel === embedder.model) : [];
		const embeddedConcepts = embedder && conceptModel === embedder.model ? conceptCandidates.filter((c) => c.vector) : [];
		if (!embedder) {
			note = "Keyword search only: no OpenRouter key is set, so documents are not embedded.";
		} else if (embedded.length === 0 && embeddedConcepts.length === 0) {
			note = "Keyword search only: the documents are not embedded yet (indexing runs in the background).";
		} else {
			try {
				const budget = deps.queryTimeoutMs ?? 2500;
				// Belt and braces: the embedder is handed the budget, and the race
				// below holds even for one that ignores it.
				const [qv] = await withTimeout(embedder.embed([query], { timeoutMs: budget }), budget);
				if (!qv) throw new Error("no query vector");
				const q = normalize(qv);
				const scored = [
					...embedded
						.flatMap((d) => d.chunks)
						.flatMap((c) => (c.vector && c.vector.length === q.length ? [{ id: c.id, sim: cosine(q, c.vector) }] : [])),
					...embeddedConcepts.flatMap((c) => (c.vector && c.vector.length === q.length ? [{ id: c.id, sim: cosine(q, c.vector) }] : [])),
				];
				semantic = scored
					.filter((x) => x.sim > 0)
					.sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : 1))
					.slice(0, CANDIDATES)
					.map((x) => x.id);
				mode = "hybrid";
				const parts: string[] = [];
				if (candidates.length > embedded.length) parts.push(`${candidates.length - embedded.length} of ${candidates.length} documents`);
				if (conceptCandidates.length > embeddedConcepts.length) {
					parts.push(`${conceptCandidates.length - embeddedConcepts.length} of ${conceptCandidates.length} concepts`);
				}
				if (parts.length > 0) note = `${parts.join(" and ")} are not embedded yet and matched by keywords only.`;
			} catch (err) {
				note = `Keyword search only: the query could not be embedded (${err instanceof Error ? err.message : err}).`;
			}
		}

		// Bundle paths come from the helpers the bundle renderer uses (same
		// collision rule), over the same documents and concepts.
		const docPaths = documentPaths([...docs.values()]);
		const conceptPathOf = conceptPaths([...concepts.values()].map((c) => c.node));

		// One hit per section: its best-ranked unit (a hit names a section to read).
		const seen = new Set<string>();
		const hits: DocSearchHit[] = rrf([keyword.map((k) => k.id), semantic])
			.filter(({ id }) => {
				const chunk = chunkById.get(id);
				const key = chunk ? `${chunk.docId}/${chunk.unit.sectionId}` : id;
				return !seen.has(key) && !!seen.add(key);
			})
			.slice(0, limit)
			.map(({ id, score }): DocSearchHit => {
				const concept = concepts.get(id);
				if (concept) {
					return {
						kind: "concept",
						path: conceptPathOf.get(concept.node.id) ?? "",
						docId: "",
						conceptId: concept.node.id,
						title: concept.node.name,
						sectionId: "",
						headingPath: [],
						snippet: snippetAround(concept.node.statement, tokens),
						score,
					};
				}
				const c = chunkById.get(id)!;
				const d = docs.get(c.docId)!;
				return {
					kind: "section",
					path: sectionPath(docPaths.get(d.id) ?? "", { id: c.unit.sectionId, headingPath: c.unit.headingPath }),
					docId: d.id,
					title: d.title,
					sectionId: c.unit.sectionId,
					headingPath: c.unit.headingPath,
					...(c.unit.pageFrom !== undefined ? { pageFrom: c.unit.pageFrom, pageTo: c.unit.pageTo } : {}),
					snippet: snippetAround(c.unit.text, tokens),
					score,
				};
			});
		return { mode, query, hits, ...(note ? { note } : {}) };
	}

	return { search, indexDocument, removeDocument, reindex, kickBackfill, tick };
}

export type DocIndex = ReturnType<typeof createDocIndex>;

// ─── the wired instance ──────────────────────────────────────────────────────

/** The embedder the current key + settings describe, or null without a key. */
function liveEmbedder(): Embedder | null {
	const key = keyValue("OPENROUTER_API_KEY");
	return key ? openRouterEmbedder(key, effectiveSettings().documents.embeddingModel) : null;
}

function liveBatcher(): BatchClient | null {
	const key = keyValue("OPENROUTER_API_KEY");
	return key ? openRouterBatchClient(key, effectiveSettings().documents.embeddingModel) : null;
}

// Anchored on globalThis like the other registries: Next may load this module
// once per route bundle, and every copy must share ONE index (the store
// wrapper that feeds it and the search route would otherwise disagree).
interface IndexGlobal {
	__lhDocIndex?: DocIndex;
}
export const docIndex: DocIndex = ((globalThis as IndexGlobal).__lhDocIndex ??= createDocIndex({
	store: stores.documentStore,
	graphStore: stores.graphStore,
	conceptVectors: stores.conceptVectorStore,
	conceptsEnabled: () => graphToolsEnabled(effectiveSettings()),
	embedder: liveEmbedder,
	batcher: liveBatcher,
	batchMode: () => effectiveSettings().documents.embeddingBatch,
}));
