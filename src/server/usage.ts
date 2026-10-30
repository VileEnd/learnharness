/**
 * The usage surface (cost counter, 2026-10-29): the month view, the
 * 12-month strip and the failed-request pages behind /api/usage, all folded
 * from the request log (data/logs) at read time and priced with callCost
 * (one pricer per fold; custom calls count only their call-time stamp).
 * Plus the ONE-TIME backfill: the usage the records already hold (chat
 * turns, extraction runs, jobs, OCR'd documents) enters the log as
 * `imported: true` lines, so the month is right on day one and a deleted
 * chat no longer takes its spend with it.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { CallUsage, ChatRecord, ExtractionRunUsage, JobKind } from "../core/contracts.ts";
import type { RequestLogLine, UsageFailuresPage, UsageMonthTotal, UsageMonthView } from "../core/contracts/usage.ts";
import { categoryOf, monthKey, summarizeMonth } from "../core/usage.ts";
import { createPricer } from "./pricing.ts";
import { stores } from "./stores.ts";

/** One month folded and priced (default: the current Berlin month). Each
 *  session carries its chat's title and kind; a chat that no longer exists
 *  keeps its spend as "Deleted session". */
export function usageMonth(month: string = monthKey(new Date())): UsageMonthView {
	ensureBackfill();
	const summary = summarizeMonth(month, stores.requestLog.readMonth(month), createPricer({ customFromConfig: false }));
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

/** One month's priced total and unpriced count, without the session view
 *  (the cap check: no chat reads). Unpriced calls count 0 here; the caller
 *  keeps the count so they are never mistaken for free. */
export function monthSpend(month: string = monthKey(new Date())): { usd: number; unpriced: number } {
	ensureBackfill();
	const { totalUsd, unpricedCalls } = summarizeMonth(month, stores.requestLog.readMonth(month), createPricer({ customFromConfig: false }));
	return { usd: totalUsd ?? 0, unpriced: unpricedCalls };
}

/** The last 12 months that have a log file, oldest first. */
export function usageMonths(): UsageMonthTotal[] {
	ensureBackfill();
	return stores.requestLog
		.months()
		.slice(-12)
		.map((month) => {
			const { totalUsd, unpricedCalls } = summarizeMonth(month, stores.requestLog.readMonth(month), createPricer({ customFromConfig: false }));
			return { month, totalUsd, unpricedCalls };
		});
}

const FAILURE_PAGE = 50;

/** One page of the month's failed requests (outcome "error"), newest first. */
export function usageFailures(month: string, page: number): UsageFailuresPage {
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

/** Runs recorded before extraction carried stages have none: they count
 *  nothing (the old cost summary's guard). */
function extractionLines(runs: readonly ExtractionRunUsage[] | undefined, chatId?: string): RequestLogLine[] {
	return (runs ?? []).flatMap((run) =>
		(["extractor", "auditor"] as const).flatMap((stage) => {
			const recorded = run.stages?.[stage];
			return (recorded?.steps ?? []).map((s) =>
				importedLine(run.at, recorded?.model ?? "unknown", s, { purpose: stage, ...(chatId && { chatId }) }),
			);
		}),
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

/** The file ids in a store directory (`<id>.json`); [] when it is absent.
 *  Read here, not through listChats: the list's summary projection drops a
 *  record whose messages fail it, and that record's spend is still real. */
function idsIn(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
	} catch {
		return [];
	}
}

/** One imported line, and when the record it came from was complete: the
 *  cutoff compares that, so a job that ran on past the first live line is
 *  left to the live log. */
interface Candidate {
	line: RequestLogLine;
	doneAt: string;
}

const asCandidate = (line: RequestLogLine): Candidate => ({ line, doneAt: line.at });

/** One record's lines, or none when the record is malformed in a way no
 *  guard foresaw: one bad record must never kill the whole backfill. */
function linesOf(record: string, build: () => Candidate[]): Candidate[] {
	try {
		return build();
	} catch (err) {
		console.error(`[usage] backfill skipped ${record}:`, err);
		return [];
	}
}

/** Every line the records can account for, before any cutoff. */
function recordLines(): Candidate[] {
	const out: Candidate[] = [];
	for (const id of idsIn(PATHS.chats)) {
		out.push(
			...linesOf(`chat ${id}`, () => {
				const chat = stores.chatStore.getChat(id);
				return chat ? [...turnLines(chat), ...extractionLines(chat.extractions, chat.id)].map(asCandidate) : [];
			}),
		);
	}
	// Every job file once, whatever its chat: a job outliving its chat still spent.
	for (const id of idsIn(path.join(PATHS.data, "jobs"))) {
		out.push(
			...linesOf(`job ${id}`, () => {
				const job = stores.jobStore.getJob(id);
				const u = job?.usage;
				if (!job || !u || u.steps < 1) return [];
				const owner = { purpose: JOB_PURPOSE[job.kind] ?? job.kind, chatId: job.chatId };
				const calls: Partial<CallUsage>[] = u.calls?.length ? u.calls : [u];
				// Dated at the start (the daily chart), cut at completion.
				return calls.map((c) => ({ line: importedLine(job.createdAt, u.model, c, owner), doneAt: job.updatedAt }));
			}),
		);
	}
	for (const source of stores.graphStore.readSources()) {
		out.push(...linesOf(`source ${source.id}`, () => extractionLines(source.extractions).map(asCandidate)));
	}
	// A reused scan copies its job and cost onto the new document: one OCR
	// job is one charge, dated at its first import.
	const scans = new Set<string>();
	const docs = [...stores.documentStore.listMetas()].sort((a, b) => a.importedAt.localeCompare(b.importedAt));
	for (const doc of docs) {
		if (!doc.ocr || !Number.isFinite(doc.ocr.costUsd) || scans.has(doc.ocr.job)) continue;
		scans.add(doc.ocr.job);
		out.push(
			asCandidate({
				v: 1,
				at: doc.importedAt,
				purpose: "ocr",
				category: categoryOf("ocr"),
				provider: "ocr",
				model: doc.ocr.strategy || "ocr",
				providerCostUsd: doc.ocr.costUsd,
				outcome: "ok",
				imported: true,
			}),
		);
	}
	return out;
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
 * exists). Only records completed before the oldest live line are imported:
 * from that moment on the live sink logged them already. A run that died before
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
		.filter((c) => cutoff === null || c.doneAt < cutoff)
		.map((c) => c.line)
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

/** The read path runs the backfill itself when the boot run has not
 *  finished yet (the first /api/usage after a start), so no month view is
 *  ever folded from a log without the records' history. Idempotent and
 *  synchronous; a failure costs the history, never the read. */
function ensureBackfill(): void {
	if (stores.requestLog.backfillDone()) return;
	try {
		runUsageBackfill();
	} catch (err) {
		console.error("[usage] the usage backfill failed:", err);
	}
}
