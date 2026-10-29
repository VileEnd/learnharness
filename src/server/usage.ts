/**
 * The usage surface (cost counter, 2026-10-29): the month view, the
 * 12-month strip and the failed-request pages behind /api/usage, all folded
 * from the request log (data/logs) at read time and priced with callCost.
 * Plus the ONE-TIME backfill: the usage the records already hold (chat
 * turns, extraction runs, jobs, OCR'd documents) enters the log as
 * `imported: true` lines, so the month is right on day one and a deleted
 * chat no longer takes its spend with it.
 */

import type { CallUsage, ChatRecord, ExtractionRunUsage, JobKind } from "../core/contracts.ts";
import type { RequestLogLine, UsageMonth } from "../core/contracts/usage.ts";
import { categoryOf, monthKey, summarizeMonth } from "../core/usage.ts";
import { callCost } from "./pricing.ts";
import { stores } from "./stores.ts";

export interface UsageMonthView extends UsageMonth {
	sessions: Array<UsageMonth["sessions"][number] & { title: string; kind: "teach" | "practice" | "deleted" }>;
}

/** One month folded and priced (default: the current Berlin month). Each
 *  session carries its chat's title and kind; a chat that no longer exists
 *  keeps its spend as "Deleted session". */
export function usageMonth(month: string = monthKey(new Date())): UsageMonthView {
	const summary = summarizeMonth(month, stores.requestLog.readMonth(month), callCost);
	return {
		...summary,
		sessions: summary.sessions.map((s) => {
			const chat = stores.chatStore.getChat(s.chatId);
			return chat
				? { ...s, title: chat.title, kind: chat.kind ?? "teach" }
				: { ...s, title: "Deleted session", kind: "deleted" };
		}),
	};
}

/** The last 12 months that have a log file, oldest first. */
export function usageMonths(): Array<{ month: string; totalUsd: number | null; unpricedCalls: number }> {
	return stores.requestLog
		.months()
		.slice(-12)
		.map((month) => {
			const { totalUsd, unpricedCalls } = summarizeMonth(month, stores.requestLog.readMonth(month), callCost);
			return { month, totalUsd, unpricedCalls };
		});
}

const FAILURE_PAGE = 50;

/** One page of the month's failed requests (outcome "error"), newest first. */
export function usageFailures(month: string, page: number): { lines: RequestLogLine[]; total: number; pageSize: 50 } {
	const failed = stores.requestLog
		.readMonth(month)
		.filter((l) => l.outcome === "error")
		.sort((a, b) => b.at.localeCompare(a.at));
	const start = Math.max(0, Math.floor(page)) * FAILURE_PAGE;
	return { lines: failed.slice(start, start + FAILURE_PAGE), total: failed.length, pageSize: FAILURE_PAGE };
}

// ─── The one-time backfill ───────────────────────────────────────────────────

/** Job kind -> the role its sub-agent runs as (runner.ts KIND_ROLE). */
const JOB_PURPOSE: Partial<Record<JobKind, string>> = {
	research: "researcher",
	demo: "demoBuilder",
	visual: "visualMaker",
};

function splitModel(qualified: string): { provider: string; model: string } {
	const colon = qualified.indexOf(":");
	return colon < 0 ? { provider: "", model: qualified } : { provider: qualified.slice(0, colon), model: qualified.slice(colon + 1) };
}

interface LineOwner {
	purpose: string;
	chatId?: string;
	chatKind?: "teach" | "practice";
}

/** One imported line for one recorded call: tokens and time only (no
 *  duration, no error: the records never had them). */
function importedLine(at: string, qualifiedModel: string, call: Partial<CallUsage>, owner: LineOwner): RequestLogLine {
	return {
		v: 1,
		at,
		purpose: owner.purpose,
		category: categoryOf(owner.purpose, owner.chatKind, owner.chatId),
		...(owner.chatId !== undefined && { chatId: owner.chatId }),
		...(owner.chatKind !== undefined && { chatKind: owner.chatKind }),
		...splitModel(qualifiedModel),
		...(call.inputTokens !== undefined && { input: call.inputTokens }),
		...(call.outputTokens !== undefined && { output: call.outputTokens }),
		...(call.cacheReadTokens !== undefined && { cacheRead: call.cacheReadTokens }),
		...(call.cacheWriteTokens !== undefined && { cacheWrite: call.cacheWriteTokens }),
		...(call.cacheWrite1hTokens !== undefined && { cacheWrite1h: call.cacheWrite1hTokens }),
		outcome: "ok",
		imported: true,
	};
}

function extractionLines(runs: readonly ExtractionRunUsage[] | undefined, chatId?: string): RequestLogLine[] {
	return (runs ?? []).flatMap((run) =>
		(["extractor", "auditor"] as const).flatMap((stage) =>
			run.stages[stage].steps.map((s) => importedLine(run.at, run.stages[stage].model, s, { purpose: stage, ...(chatId && { chatId }) })),
		),
	);
}

/** A chat's turn lines. Compaction entries are keyed to their marker
 *  message; the drawing reader's entry has a plain random id and cannot be
 *  told apart, so it takes the chat kind's turn purpose. */
function turnLines(chat: ChatRecord): RequestLogLine[] {
	const chatKind = chat.kind ?? "teach";
	const markers = new Set(
		chat.messages
			.filter((m) => (m as { role?: string; customType?: string }).role === "custom" && (m as { customType?: string }).customType === "compaction")
			.map((m) => m.id),
	);
	return (chat.turns ?? []).flatMap((turn) => {
		const purpose = markers.has(turn.messageId) ? "compaction" : chatKind === "practice" ? "practice" : "teacher";
		return turn.steps.map((s) => importedLine(turn.at, turn.model, s, { purpose, chatId: chat.id, chatKind }));
	});
}

/** Every line the records can account for, before any cutoff. */
function recordLines(): RequestLogLine[] {
	const lines: RequestLogLine[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const chat = stores.chatStore.getChat(summary.id);
		if (chat) lines.push(...turnLines(chat), ...extractionLines(chat.extractions, chat.id));
		for (const job of stores.jobStore.listJobs(summary.id)) {
			const u = job.usage;
			if (!u || u.steps < 1) continue;
			const owner = { purpose: JOB_PURPOSE[job.kind] ?? job.kind, chatId: job.chatId };
			const calls: Partial<CallUsage>[] = u.calls?.length ? u.calls : [u];
			lines.push(...calls.map((c) => importedLine(job.createdAt, u.model, c, owner)));
		}
	}
	for (const source of stores.graphStore.readSources()) lines.push(...extractionLines(source.extractions));
	for (const doc of stores.documentStore.listMetas()) {
		if (!doc.ocr || !Number.isFinite(doc.ocr.costUsd)) continue;
		lines.push({
			v: 1,
			at: doc.importedAt,
			purpose: "ocr",
			category: categoryOf("ocr"),
			provider: "ocr",
			model: doc.ocr.strategy || "ocr",
			providerCostUsd: doc.ocr.costUsd,
			outcome: "ok",
			imported: true,
		});
	}
	return lines;
}

/** The oldest line the live sink wrote (imported lines do not count), or
 *  null for a log with none. */
function oldestLiveAt(): string | null {
	for (const month of stores.requestLog.months()) {
		let oldest: string | null = null;
		for (const l of stores.requestLog.readMonth(month)) {
			if (!l.imported && (oldest === null || l.at < oldest)) oldest = l.at;
		}
		if (oldest !== null) return oldest;
	}
	return null;
}

/**
 * Import the records' usage into the log ONCE (a no-op once the marker
 * exists). Only records older than the oldest live line are imported: from
 * that moment on the live sink logged them already. A run that died before
 * the marker leaves its lines behind; the rerun skips each line already
 * imported (counted, so two identical calls both survive).
 */
export function runUsageBackfill(): { imported: number } {
	const log = stores.requestLog;
	if (log.backfillDone()) return { imported: 0 };
	const cutoff = oldestLiveAt();
	const already = new Map<string, number>();
	for (const month of log.months()) {
		for (const l of log.readMonth(month)) {
			if (!l.imported) continue;
			const key = JSON.stringify(l);
			already.set(key, (already.get(key) ?? 0) + 1);
		}
	}
	let imported = 0;
	const fresh = recordLines()
		.filter((l) => cutoff === null || l.at < cutoff)
		.sort((a, b) => a.at.localeCompare(b.at));
	for (const line of fresh) {
		const key = JSON.stringify(line);
		const seen = already.get(key) ?? 0;
		if (seen > 0) {
			already.set(key, seen - 1);
			continue;
		}
		log.append(line);
		imported++;
	}
	log.markBackfilled();
	return { imported };
}
