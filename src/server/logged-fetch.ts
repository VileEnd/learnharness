/**
 * Request-log seam for the non-LLM paid calls (embeddings, OCR, search): wrap
 * a fetch so every call becomes ONE RequestLogLine through recordRequest (the
 * one sink). The response is cloned to read a provider-reported cost, so the
 * caller's body is never consumed. Logging is a side channel: nothing here
 * throws into the call, and a network throw is logged then rethrown as-is.
 */
import { recordRequest } from "../agent/request-log.ts";
import type { RequestLogLine } from "../core/contracts/usage.ts";
import { categoryOf, truncateError } from "../core/usage.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface LoggedFetchMeta {
	purpose: string;
	provider: string;
	model: string;
	chatId?: string;
}

function lineOf(meta: LoggedFetchMeta, startedAt: number, outcome: "ok" | "error", extra: Partial<RequestLogLine>): RequestLogLine {
	return {
		v: 1,
		at: new Date(startedAt).toISOString(),
		purpose: meta.purpose,
		category: categoryOf(meta.purpose, undefined, meta.chatId),
		...(meta.chatId !== undefined && { chatId: meta.chatId }),
		provider: meta.provider,
		model: meta.model,
		durationMs: Date.now() - startedAt,
		outcome,
		...extra,
	};
}

export function loggedFetch(fetchFn: FetchLike, meta: LoggedFetchMeta, costOf?: (body: unknown) => number | undefined): FetchLike {
	return async (input, init) => {
		const startedAt = Date.now();
		let resp: Response;
		try {
			resp = await fetchFn(input, init);
		} catch (err) {
			recordRequest(lineOf(meta, startedAt, "error", { error: truncateError(err instanceof Error ? err.message : String(err)) }));
			throw err;
		}
		try {
			if (!resp.ok) {
				recordRequest(lineOf(meta, startedAt, "error", { error: `HTTP ${resp.status}` }));
			} else {
				let cost: number | undefined;
				if (costOf) {
					try {
						const value = costOf(await resp.clone().json());
						if (typeof value === "number" && Number.isFinite(value)) cost = value;
					} catch {
						// not JSON, or no cost reported: the line simply has no cost
					}
				}
				recordRequest(lineOf(meta, startedAt, "ok", cost !== undefined ? { providerCostUsd: cost } : {}));
			}
		} catch (err) {
			console.error("[request-log] could not log a call:", err);
		}
		return resp;
	};
}
