/**
 * The request log (data/logs/requests-YYYY-MM.jsonl): one append-only line per
 * paid call, and the month summary folded from it. Dollars are NOT stored
 * except provider-reported ones; everything else is inferred at read time.
 */

export type UsageCategory =
	| "teaching"
	| "practice"
	| "canvas-reader"
	| "graph"
	| "jobs"
	| "library"
	| "learner"
	| "search";

export type RequestOutcome = "ok" | "error" | "aborted";

export interface RequestLogLine {
	v: 1;
	/** ISO timestamp of the request start. */
	at: string;
	purpose: string;
	category: UsageCategory;
	chatId?: string;
	chatKind?: "teach" | "practice";
	provider: string;
	model: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	/** Provider-reported dollars (OCR, batch embeddings, sync embeddings). */
	providerCostUsd?: number;
	durationMs?: number;
	outcome: RequestOutcome;
	/** Truncated to 1000 chars; the log holds no prompt or answer text. */
	error?: string;
	imported?: true;
}

export interface CategoryTotal {
	usd: number | null;
	calls: number;
	tokens: number;
	unpriced: number;
}

export interface UsageMonth {
	/** "YYYY-MM" in the usage time zone. */
	month: string;
	totalUsd: number | null;
	calls: number;
	unpricedCalls: number;
	failures: number;
	categories: Record<UsageCategory, CategoryTotal>;
	days: Array<{ day: string; byCategory: Partial<Record<UsageCategory, number>> }>;
	/** Sorted by usd descending, null last. */
	sessions: Array<{ chatId: string; usd: number | null; calls: number }>;
}
