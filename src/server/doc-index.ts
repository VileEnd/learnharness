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
	sliceDocument,
	snippetAround,
	tokenize,
	topicMatches,
	type ChunkUnit,
} from "../core/doc-search.ts";
import type {
	DocListEntry,
	DocReadQuery,
	DocReadResult,
	DocSearchHit,
	DocSearchQuery,
	DocSearchResult,
} from "../core/doc-search.ts";
import type { DocumentMeta } from "../core/contracts/documents.ts";
import type { DocumentStore } from "../core/ports.ts";
import { keyValue } from "./keys.ts";
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

// ─── the index ───────────────────────────────────────────────────────────────

export interface DocIndexDeps {
	store: DocumentStore;
	/** The live embedder (key present + current model), or null. Read per call. */
	embedder(): Embedder | null;
	/** Query-embedding budget before a search falls back to keywords. */
	queryTimeoutMs?: number;
	/** Texts per embeddings request. */
	batchSize?: number;
	/** Pause between a document's embedding batches (default 250ms). */
	batchPauseMs?: number;
	/** Pause after a failed backfill before the next attempt. */
	backoffMs?: number;
	now?: () => number;
}

interface IndexedChunk {
	id: string;
	docId: string;
	unit: ChunkUnit;
	vector?: Float32Array;
}

interface IndexedDoc {
	id: string;
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
	let built = false;
	let running: Promise<void> | null = null;
	let again = false;
	let backoffUntil = 0;

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
		const doc: IndexedDoc = { id: meta.id, title: meta.title, topics: meta.topics, contentHash: meta.contentHash, chunks };
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

	function ensureBuilt(): void {
		if (built) return;
		built = true;
		for (const meta of store.listMetas()) {
			try {
				load(meta);
			} catch (err) {
				console.warn(`[doc-index] skipped ${meta.id}: ${err instanceof Error ? err.message : err}`);
			}
		}
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
		kickBackfill();
	}

	function removeDocument(id: string): void {
		drop(id);
	}

	// ── background embedding ──────────────────────────────────────────────────

	function needsVectors(doc: IndexedDoc, model: string): boolean {
		return doc.chunks.length > 0 && doc.vectorModel !== model;
	}

	/** Embed every document lacking vectors for the live model. One run at a
	 *  time; a trigger during a run asks for one more pass. */
	function kickBackfill(): void {
		if (running) {
			again = true;
			return;
		}
		const embedder = deps.embedder();
		if (!embedder || now() < backoffUntil) return;
		if (![...docs.values()].some((d) => needsVectors(d, embedder.model))) return;
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
				if (!doc) return;
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
		const flat = new Float32Array(vectors.length * dims);
		vectors.forEach((v, i) => flat.set(v, i * dims));
		store.writeVectors(doc.id, {
			model: embedder.model,
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
		doc.vectorModel = embedder.model;
	}

	/** Re-embed the whole library with the current model (settings action). */
	function reindex(): { documents: number } {
		ensureBuilt();
		for (const d of docs.values()) d.vectorModel = undefined;
		backoffUntil = 0;
		kickBackfill();
		return { documents: docs.size };
	}

	// ── search ────────────────────────────────────────────────────────────────

	function candidateDocs(q: DocSearchQuery): IndexedDoc[] {
		return [...docs.values()].filter(
			(d) => (!q.topic || topicMatches(d.topics, q.topic)) && (!q.document || documentMatches(d, q.document)),
		);
	}

	async function search(input: DocSearchQuery & { query: string }): Promise<DocSearchResult> {
		ensureBuilt();
		kickBackfill(); // a model change or a new key is noticed here, never waited for
		const query = input.query.trim();
		const limit = Math.min(SEARCH_LIMIT.max, Math.max(1, Math.floor(input.limit ?? SEARCH_LIMIT.default)));
		const candidates = candidateDocs(input);
		const empty = (note: string): DocSearchResult => ({ mode: "keyword", query, hits: [], note });
		if (query === "") return empty("Empty query.");
		if (docs.size === 0) return empty("The library has no documents yet.");
		if (candidates.length === 0) return empty("No document matches that topic or document filter. Call list_documents for what exists.");

		const allowed = new Set(candidates.map((d) => d.id));
		const tokens = tokenize(query);
		const keyword = bm25.search(tokens, (id) => allowed.has(chunkById.get(id)!.docId)).slice(0, CANDIDATES);

		// The vector leg: only documents embedded with the live model take part.
		let mode: DocSearchResult["mode"] = "keyword";
		let note: string | undefined;
		let semantic: string[] = [];
		const embedder = deps.embedder();
		const embedded = embedder ? candidates.filter((d) => d.vectorModel === embedder.model) : [];
		if (!embedder) {
			note = "Keyword search only: no OpenRouter key is set, so documents are not embedded.";
		} else if (embedded.length === 0) {
			note = "Keyword search only: the documents are not embedded yet (indexing runs in the background).";
		} else {
			try {
				const budget = deps.queryTimeoutMs ?? 2500;
				// Belt and braces: the embedder is handed the budget, and the race
				// below holds even for one that ignores it.
				const [qv] = await withTimeout(embedder.embed([query], { timeoutMs: budget }), budget);
				if (!qv) throw new Error("no query vector");
				const q = normalize(qv);
				semantic = embedded
					.flatMap((d) => d.chunks)
					.flatMap((c) => (c.vector && c.vector.length === q.length ? [{ id: c.id, sim: cosine(q, c.vector) }] : []))
					.filter((x) => x.sim > 0)
					.sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : 1))
					.slice(0, CANDIDATES)
					.map((x) => x.id);
				mode = "hybrid";
				const pending = candidates.length - embedded.length;
				if (pending > 0) note = `${pending} of ${candidates.length} documents are not embedded yet and matched by keywords only.`;
			} catch (err) {
				note = `Keyword search only: the query could not be embedded (${err instanceof Error ? err.message : err}).`;
			}
		}

		// One hit per section: its best-ranked unit (a hit names a section to read).
		const seen = new Set<string>();
		const hits: DocSearchHit[] = rrf([keyword.map((k) => k.id), semantic])
			.filter(({ id }) => {
				const c = chunkById.get(id)!;
				const key = `${c.docId}/${c.unit.sectionId}`;
				return !seen.has(key) && !!seen.add(key);
			})
			.slice(0, limit)
			.map(({ id, score }) => {
				const c = chunkById.get(id)!;
				const d = docs.get(c.docId)!;
				return {
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

	// ── list / read ───────────────────────────────────────────────────────────

	function list(input: { topic?: string } = {}): DocListEntry[] {
		return store
			.listMetas()
			.filter((m) => !input.topic || topicMatches(m.topics, input.topic))
			.map((m) => ({ docId: m.id, title: m.title, topics: m.topics, ...(m.pages !== undefined ? { pages: m.pages } : {}) }));
	}

	function read(input: { document: string } & DocReadQuery): DocReadResult {
		const metas = store.listMetas();
		const exact = metas.filter((m) => m.id === input.document.trim());
		const found = exact.length > 0 ? exact : metas.filter((m) => documentMatches(m, input.document));
		if (found.length === 0) return { ok: false, error: `No document matches "${input.document}". Call list_documents for the ids.` };
		if (found.length > 1) {
			return {
				ok: false,
				error: `"${input.document}" matches ${found.length} documents; pass the docId:\n${found.map((m) => `- ${m.id} · ${m.title}`).join("\n")}`,
			};
		}
		const meta = found[0]!;
		const markdown = store.readMarkdown(meta.id);
		if (markdown === null) return { ok: false, error: `Document ${meta.id} could not be read.` };
		return sliceDocument(meta, markdown, input);
	}

	return { search, list, read, indexDocument, removeDocument, reindex, kickBackfill };
}

export type DocIndex = ReturnType<typeof createDocIndex>;

// ─── the wired instance ──────────────────────────────────────────────────────

/** The embedder the current key + settings describe, or null without a key. */
function liveEmbedder(): Embedder | null {
	const key = keyValue("OPENROUTER_API_KEY");
	return key ? openRouterEmbedder(key, effectiveSettings().documents.embeddingModel) : null;
}

// Anchored on globalThis like the other registries: Next may load this module
// once per route bundle, and every copy must share ONE index (the store
// wrapper that feeds it and the search route would otherwise disagree).
interface IndexGlobal {
	__lhDocIndex?: DocIndex;
}
export const docIndex: DocIndex = ((globalThis as IndexGlobal).__lhDocIndex ??= createDocIndex({
	store: stores.documentStore,
	embedder: liveEmbedder,
}));
