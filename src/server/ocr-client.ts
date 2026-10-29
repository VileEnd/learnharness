/**
 * Client for the OCR sidecar (services/ocr): scanned PDFs in, markdown with
 * front matter out. The sidecar is an optional deployment piece - OCR_URL
 * unset (plain dev) means PDF import is refused with a clear message, while
 * markdown import never needs it.
 *
 *   OCR_URL     base URL of the sidecar
 *   OCR_TOKEN   shared secret, sent as X-OCR-Token
 *   key         the learner's OpenRouter key (BYOK, src/server/keys.ts),
 *               forwarded per request as X-OpenRouter-Key - the sidecar
 *               never stores one
 *
 * Contract: POST /api/run (multipart "files", optional "strategy") -> {job};
 * GET /api/jobs/{id}; GET /api/jobs/{id}/files/{markdown};
 * GET /api/by-sha/{sha256} (200 | 404); POST /api/estimate.
 */

import { recordRequest } from "../agent/request-log.ts";
import { categoryOf, truncateError } from "../core/usage.ts";
import { keyValue } from "./keys.ts";
import { assertWithinCap } from "./model-gate.ts";

export type OcrStrategy = "vision" | "ocr+vision";

export interface OcrFileStatus {
	name: string;
	sha256: string;
	status: "queued" | "running" | "done" | "failed";
	pages: number;
	done_pages: number;
	failed_pages: number[];
	markdown: string | null;
	title: string | null;
	summary: string | null;
	topics: string[];
	cost_usd: number;
	error: string | null;
}

export interface OcrJob {
	id: string;
	status: "running" | "done" | "failed";
	strategy: string;
	usd: number;
	files: OcrFileStatus[];
}

export interface OcrKnown {
	job: string;
	markdown: string;
	title: string;
	summary: string;
	topics: string[];
	pages: number;
	cost_usd: number;
}

export interface OcrEstimate {
	files: { name: string; pages: number; usd: Record<string, number> }[];
	usd: Record<string, number>;
	default_strategy: string;
}

export interface OcrUpload {
	name: string;
	bytes: Uint8Array;
}

/** Why a PDF could not be scanned; `code` is the machine discriminator. */
export class OcrError extends Error {
	constructor(
		public readonly code: "ocr_not_configured" | "openrouter_key_missing" | "ocr_unreachable" | "ocr_failed",
		message: string,
	) {
		super(message);
		this.name = "OcrError";
	}
}

export interface OcrClient {
	/** True when OCR_URL is set. */
	configured(): boolean;
	/** Throws OcrError unless a scan could start: configured AND an OpenRouter key present. */
	assertCanScan(): void;
	estimate(files: OcrUpload[]): Promise<OcrEstimate>;
	start(files: OcrUpload[], strategy?: OcrStrategy): Promise<string>;
	job(id: string): Promise<OcrJob>;
	markdown(job: string, name: string): Promise<string>;
	/** The sidecar's earlier conversion of these exact PDF bytes, or null. */
	bySha(sha256: string): Promise<OcrKnown | null>;
}

export interface OcrClientOptions {
	baseUrl?: () => string | undefined;
	token?: () => string | undefined;
	key?: () => string | undefined;
	fetch?: typeof fetch;
}

/** Job ids already logged (one line per job, however often it is polled). */
const loggedJobs = new Set<string>();

export function createOcrClient(opts: OcrClientOptions = {}): OcrClient {
	const baseUrl = opts.baseUrl ?? (() => process.env.OCR_URL);
	const token = opts.token ?? (() => process.env.OCR_TOKEN);
	const key = opts.key ?? (() => keyValue("OPENROUTER_API_KEY"));
	const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

	/** One request-log line per finished OCR job (or failed call): purpose
	 *  "ocr", the sidecar's own cost_usd, never any page text. */
	function log(startedAt: number, model: string, outcome: "ok" | "error", extra: { providerCostUsd?: number; error?: string } = {}): void {
		recordRequest({
			v: 1,
			at: new Date(startedAt).toISOString(),
			purpose: "ocr",
			category: categoryOf("ocr"),
			provider: "ocr",
			model: model || "ocr",
			durationMs: Date.now() - startedAt,
			outcome,
			...(extra.providerCostUsd !== undefined && { providerCostUsd: extra.providerCostUsd }),
			...(extra.error !== undefined && { error: truncateError(extra.error) }),
		});
	}

	function base(): string {
		const url = baseUrl()?.trim();
		if (!url) throw new OcrError("ocr_not_configured", "PDF import needs the OCR service, and OCR_URL is not set on this server.");
		return url.replace(/\/+$/, "");
	}

	async function call(path: string, init: RequestInit = {}, withKey = false): Promise<Response> {
		const headers = new Headers(init.headers);
		const t = token();
		if (t) headers.set("X-OCR-Token", t);
		if (withKey) {
			const k = key();
			if (k) headers.set("X-OpenRouter-Key", k);
		}
		const startedAt = Date.now();
		try {
			return await doFetch(`${base()}${path}`, { ...init, headers });
		} catch (err) {
			if (err instanceof OcrError) throw err;
			const unreachable = new OcrError("ocr_unreachable", `The OCR service is unreachable (${err instanceof Error ? err.message : String(err)}).`);
			log(startedAt, "ocr", "error", { error: unreachable.message });
			throw unreachable;
		}
	}

	async function json<T>(res: Response, startedAt: number): Promise<T> {
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			const failed = new OcrError("ocr_failed", `The OCR service answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
			log(startedAt, "ocr", "error", { error: failed.message });
			throw failed;
		}
		return (await res.json()) as T;
	}

	function form(files: OcrUpload[], strategy?: OcrStrategy): FormData {
		const body = new FormData();
		for (const f of files) body.append("files", new File([f.bytes as BlobPart], f.name, { type: "application/pdf" }));
		if (strategy) body.append("strategy", strategy);
		return body;
	}

	return {
		configured: () => Boolean(baseUrl()?.trim()),
		assertCanScan() {
			base();
			if (!key()) throw new OcrError("openrouter_key_missing", "PDF scanning needs an OpenRouter key. Add one under Settings, Keys.");
			// A scan is paid work: a restricted user over their monthly cap
			// (multi-user design §10) is refused with MonthlyCapReachedError,
			// which the import contains as a failed file with the cap copy.
			assertWithinCap();
		},
		async estimate(files) {
			const startedAt = Date.now();
			return json<OcrEstimate>(await call("/api/estimate", { method: "POST", body: form(files) }), startedAt);
		},
		async start(files, strategy) {
			this.assertCanScan();
			const startedAt = Date.now();
			const { job } = await json<{ job: string }>(await call("/api/run", { method: "POST", body: form(files, strategy) }, true), startedAt);
			return job;
		},
		async job(id) {
			const startedAt = Date.now();
			const status = await json<OcrJob>(await call(`/api/jobs/${encodeURIComponent(id)}`), startedAt);
			// documents.ts may poll a job-level "done" again (a file still lacks
			// markdown), so log exactly once per job id.
			if ((status.status === "done" || status.status === "failed") && !loggedJobs.has(id)) {
				loggedJobs.add(id);
				const bad = status.files.find((f) => f.status !== "done");
				// A failed job still spent what the sidecar reports (defined values only).
				const costs = status.files.map((f) => f.cost_usd).filter((c): c is number => typeof c === "number");
				const cost = costs.length > 0 ? { providerCostUsd: costs.reduce((a, c) => a + c, 0) } : {};
				if (status.status === "done" && !bad) {
					log(startedAt, status.strategy, "ok", cost);
				} else {
					log(startedAt, status.strategy, "error", { ...cost, error: bad?.error ?? status.files.find((f) => f.error)?.error ?? "OCR job failed" });
				}
			}
			return status;
		},
		async markdown(job, name) {
			const startedAt = Date.now();
			const res = await call(`/api/jobs/${encodeURIComponent(job)}/files/${encodeURIComponent(name)}`);
			if (!res.ok) {
				const failed = new OcrError("ocr_failed", `The OCR service has no markdown ${name} (HTTP ${res.status}).`);
				log(startedAt, "ocr", "error", { error: failed.message });
				throw failed;
			}
			return res.text();
		},
		async bySha(sha256) {
			const res = await call(`/api/by-sha/${encodeURIComponent(sha256)}`);
			if (res.status === 404) return null;
			return json<OcrKnown>(res, Date.now());
		},
	};
}

/** The app's one client (env-configured). */
export const ocr: OcrClient = createOcrClient();
