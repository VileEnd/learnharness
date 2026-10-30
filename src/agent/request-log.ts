/**
 * The request log's LLM seam (cost counter, 2026-10-29): every model call an
 * engine makes is observed at its streamFn (models.ts piEngineForSpec) and
 * becomes ONE RequestLogLine: who asked (purpose, chat), which model, the
 * final message's tokens, how long, and how it ended. The agent layer may not
 * import the store, so the server composition injects the sink; tests set
 * their own. Logging is a side channel: nothing here throws into a stream,
 * and no prompt or answer text is ever written (only a truncated error).
 */
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { RequestLogLine, RequestOutcome } from "../core/contracts/usage.ts";
import { NoTenantError } from "../core/tenant-context.ts";
import { categoryOf, truncateError } from "../core/usage.ts";

export type RequestSink = (line: RequestLogLine) => void;

let sink: RequestSink | null = null;
let sinkFailed = false;

/** Install (or clear, with null) the process-wide sink. */
export function setRequestSink(next: RequestSink | null): void {
	sink = next;
}

/** Hand one line to the sink. Never throws: a throwing sink costs one
 *  console.error per process, then fails silently. A wall clock that steps
 *  back (an NTP correction) would make a negative duration: every seam's
 *  duration is clamped at 0 here, as doc-index clamps its own. */
export function recordRequest(line: RequestLogLine): void {
	if (!sink) return;
	try {
		sink(line.durationMs !== undefined && line.durationMs < 0 ? { ...line, durationMs: 0 } : line);
	} catch (err) {
		// A missing tenant is a wiring bug, not a broken sink: always loud,
		// and it never spends the once-only silence.
		if (err instanceof NoTenantError) {
			console.error("[request-log] no tenant in scope; a request line was dropped:", err);
			return;
		}
		if (sinkFailed) return;
		sinkFailed = true;
		console.error("[request-log] writing the request log failed; further failures are silent:", err);
	}
}

export interface ObserveMeta {
	purpose: string;
	chatId?: string;
	chatKind?: "teach" | "practice";
	provider: string;
	model: string;
	/** Date.now() at the request start. */
	startedAt: number;
	/** Known dollars for a billable call: the free custom endpoint's real $0. */
	providerCostUsd?: number;
}

function lineOf(message: AssistantMessage, outcome: RequestOutcome, meta: ObserveMeta): RequestLogLine {
	const line: RequestLogLine = {
		v: 1,
		at: new Date(meta.startedAt).toISOString(),
		purpose: meta.purpose,
		category: categoryOf(meta.purpose, meta.chatKind, meta.chatId),
		...(meta.chatId !== undefined && { chatId: meta.chatId }),
		...(meta.chatKind !== undefined && { chatKind: meta.chatKind }),
		provider: meta.provider,
		model: meta.model,
		durationMs: Date.now() - meta.startedAt,
		outcome,
	};
	const u = message.usage;
	// A failed call with no usage reported is not billable: leave its tokens
	// absent (never zero), so the month view does not count it as unpriced.
	const billed = outcome === "ok" || (u && u.input + u.output + u.cacheRead + u.cacheWrite + (u.cacheWrite1h ?? 0) > 0);
	if (u && billed) {
		line.input = u.input;
		line.output = u.output;
		line.cacheRead = u.cacheRead;
		line.cacheWrite = u.cacheWrite;
		if (u.cacheWrite1h !== undefined) line.cacheWrite1h = u.cacheWrite1h;
		if (meta.providerCostUsd !== undefined) line.providerCostUsd = meta.providerCostUsd;
	}
	if (outcome !== "ok" && message.errorMessage) line.error = truncateError(message.errorMessage);
	return line;
}

function record(message: AssistantMessage, outcome: RequestOutcome, meta: ObserveMeta): void {
	try {
		recordRequest(lineOf(message, outcome, meta));
	} catch (err) {
		// A malformed final message must not break the stream either.
		console.error("[request-log] could not build a line:", err);
	}
}

/** Re-emit every event of `stream` unchanged and record one line when it
 *  ends: `done` = ok; `error` = error, or aborted when the stop reason says
 *  so (the withEmptyErrorRetry pattern, turn-nudge.ts). */
export function observeStream(stream: AssistantMessageEventStream, meta: ObserveMeta): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) {
				if (event.type === "done") record(event.message, "ok", meta);
				else if (event.type === "error") record(event.error, event.error.stopReason === "aborted" ? "aborted" : "error", meta);
				out.push(event);
			}
		} catch (err) {
			// The inner stream threw instead of ending in an error event: settle
			// the stream as an error step (a stream without a terminal event
			// hangs the pi loop), and log it.
			const error: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "unknown",
				provider: meta.provider,
				model: meta.model,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: err instanceof Error ? err.message : String(err),
				timestamp: Date.now(),
			};
			record(error, "error", meta);
			out.push({ type: "error", reason: "error", error });
		} finally {
			out.end();
		}
	})();
	return out;
}
