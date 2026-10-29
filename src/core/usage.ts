/**
 * Pure folds over the request log (contracts/usage.ts): month and day keys,
 * purpose -> category, per-line cost, and the month summary. No I/O.
 */

import type { CallUsage } from "./contracts.ts";
import type { CategoryTotal, RequestLogLine, UsageCategory, UsageMonth } from "./contracts/usage.ts";

export const USAGE_TZ = "Europe/Berlin";

const CATEGORIES: readonly UsageCategory[] = [
	"teaching",
	"practice",
	"canvas-reader",
	"graph",
	"jobs",
	"library",
	"learner",
	"search",
];

const fmt = new Intl.DateTimeFormat("en-CA", {
	timeZone: USAGE_TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

function parts(at: string | Date): { y: string; m: string; d: string } {
	const p = fmt.formatToParts(typeof at === "string" ? new Date(at) : at);
	const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
	return { y: get("year"), m: get("month"), d: get("day") };
}

/** "YYYY-MM" in USAGE_TZ. */
export function monthKey(at: string | Date): string {
	const { y, m } = parts(at);
	return `${y}-${m}`;
}

/** "YYYY-MM-DD" in USAGE_TZ. */
export function dayKey(at: string | Date): string {
	const { y, m, d } = parts(at);
	return `${y}-${m}-${d}`;
}

/** Purpose -> category. Accepts both the ModelRole spelling (demoBuilder,
 *  visualMaker) and the kebab-case spelling (demo-builder, visual-maker). */
export function categoryOf(purpose: string, chatKind?: "teach" | "practice", chatId?: string): UsageCategory {
	switch (purpose) {
		case "prober":
		case "teacher":
			return "teaching";
		case "practice":
			return "practice";
		case "compaction":
			return chatKind === "practice" ? "practice" : "teaching";
		case "transcriber":
			return "canvas-reader";
		case "extractor":
		case "auditor":
			return "graph";
		case "researcher":
		case "demoBuilder":
		case "demo-builder":
		case "visualMaker":
		case "visual-maker":
			return "jobs";
		case "ocr":
		case "embed":
		case "embed-batch":
		case "describer":
		case "topicist":
			return "library";
		case "attribution":
			return "learner";
		case "search":
			return "search";
		default:
			return chatId ? "teaching" : "library";
	}
}

type Pricer = (call: Partial<CallUsage>, modelId: string) => number | null;

/** Provider-reported dollars win; else infer from tokens. Null = unpriced. */
export function lineCost(line: RequestLogLine, price: Pricer): number | null {
	if (line.providerCostUsd !== undefined) return line.providerCostUsd;
	return price(
		{
			inputTokens: line.input,
			outputTokens: line.output,
			cacheReadTokens: line.cacheRead,
			cacheWriteTokens: line.cacheWrite,
			cacheWrite1hTokens: line.cacheWrite1h,
		},
		`${line.provider}:${line.model}`,
	);
}

function hasUsage(l: RequestLogLine): boolean {
	return (
		l.providerCostUsd !== undefined ||
		l.input !== undefined ||
		l.output !== undefined ||
		l.cacheRead !== undefined ||
		l.cacheWrite !== undefined
	);
}

const add = (a: number | null, b: number): number => (a ?? 0) + b;

export function summarizeMonth(month: string, lines: readonly RequestLogLine[], price: Pricer): UsageMonth {
	const categories = {} as Record<UsageCategory, CategoryTotal>;
	for (const c of CATEGORIES) categories[c] = { usd: null, calls: 0, tokens: 0, unpriced: 0 };
	let totalUsd: number | null = null;
	let calls = 0;
	let unpricedCalls = 0;
	let failures = 0;
	const days = new Map<string, Partial<Record<UsageCategory, number>>>();
	const sessions = new Map<string, { chatId: string; usd: number | null; calls: number }>();

	for (const line of lines) {
		if (monthKey(line.at) !== month) continue;
		calls++;
		const cat = categories[line.category];
		cat.calls++;
		cat.tokens += (line.input ?? 0) + (line.output ?? 0) + (line.cacheRead ?? 0) + (line.cacheWrite ?? 0);
		if (line.outcome === "error") failures++;
		const session = line.chatId
			? (sessions.get(line.chatId) ?? { chatId: line.chatId, usd: null, calls: 0 })
			: undefined;
		if (session) {
			session.calls++;
			sessions.set(session.chatId, session);
		}
		const usd = lineCost(line, price);
		if (usd === null) {
			// Only billable lines count as unpriced; an error with no usage is not.
			if (line.outcome !== "error" || hasUsage(line)) {
				unpricedCalls++;
				cat.unpriced++;
			}
			continue;
		}
		totalUsd = add(totalUsd, usd);
		cat.usd = add(cat.usd, usd);
		if (session) session.usd = add(session.usd, usd);
		const day = dayKey(line.at);
		const d = days.get(day) ?? {};
		d[line.category] = (d[line.category] ?? 0) + usd;
		days.set(day, d);
	}

	return {
		month,
		totalUsd,
		calls,
		unpricedCalls,
		failures,
		categories,
		days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, byCategory]) => ({ day, byCategory })),
		sessions: [...sessions.values()].sort((a, b) => {
			if (a.usd === null || b.usd === null) return a.usd === b.usd ? 0 : a.usd === null ? 1 : -1;
			return b.usd - a.usd;
		}),
	};
}

export function truncateError(text: string): string {
	return text.length > 1000 ? text.slice(0, 1000) : text;
}
