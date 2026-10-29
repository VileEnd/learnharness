/**
 * In-turn re-prompts and the empty-error retry (RC9, RC10a; cross-model
 * robustness, 2026-10-27). Weaker models sometimes end a turn the learner
 * cannot use: after a work submission or hint request they mark/grade and
 * say nothing, or (DeepSeek) they write the plan as a diagram without
 * calling plan_init. The agent layer answers with ONE hidden steer per turn
 * through pi's follow-up queue; the steer is scaffolding, so it is stripped
 * from the agent's state at agent_end and never reaches the record or the
 * transcript. Pure predicates live here; teacher-agent.ts wires them.
 *
 * withEmptyErrorRetry covers the Gemini failure: a step that ends in an
 * error with no content ("The operation was aborted" after ~25 s, zero
 * events) while the learner did not abort is retried once. The pi loop
 * treats error steps as hard exits, so the retry sits at the stream seam.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { QUESTION_TOOLS } from "../core/pending.ts";
import {
	failedOutputCallIds,
	isInputBoundary,
	PRACTICE_PROBLEM_TOOL,
	sendToUserText,
	WORK_TOOLS,
	type LhMarkerMessage,
	type LhMessage,
} from "../core/native-messages.ts";

export const SILENT_TURN_STEER =
	"The learner saw only your marks/grade - tell him in plain text what you saw and what to do next.";
/** `spoke`: the turn already has visible prose, so ask only for the marks
 *  (asking for the reply again would make him read the coaching twice). */
export const markSteer = (drawingId: string, spoke = false) =>
	`You have not marked his drawing yet. Call annotate on drawing ${drawingId}: a mark on the first place the work breaks, or a check on what holds. ${
		spoke ? "You have already replied in text, so just mark the drawing; you need not repeat what you said." : "Then tell him in plain text what you saw and what to do next."
	}`;
/** The mark steer for a hint turn that carries his drawing: the hint goes
 *  where it points. `spoke` as for markSteer (the hint is already in prose). */
export const hintMarkSteer = (drawingId: string, spoke = false) =>
	`Mark his drawing ${drawingId} where your hint points (a circle or arrow at that spot, its note a short question)${
		spoke ? ". You have already replied in text, so just mark the drawing; you need not repeat what you said." : ", then give the hint in plain text."
	}`;
export const PLAN_INIT_STEER = "Call plan_init with that plan.";

export function newTurnNudge(text: string): LhMarkerMessage {
	return {
		id: `nudge_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		role: "custom",
		customType: "turn-nudge",
		content: text,
		display: false,
		details: null,
		timestamp: Date.now(),
	};
}

/** The messages since the last input boundary, and that boundary (if any). */
function sinceInput(messages: readonly LhMessage[]): { boundary: LhMessage | undefined; since: LhMessage[] } {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isInputBoundary(messages[i])) return { boundary: messages[i], since: messages.slice(i + 1) };
	}
	return { boundary: undefined, since: [...messages] };
}

const POSE_TOOLS: readonly string[] = [...QUESTION_TOOLS, ...WORK_TOOLS, PRACTICE_PROBLEM_TOOL];

/** Does the turn so far reach him: learner-visible prose (a text block or a
 *  clean send_to_user), or, with `orPose`, a question or task posed? */
function turnSpeaks(since: readonly LhMessage[], orPose: boolean): boolean {
	const failed = failedOutputCallIds(since);
	for (const m of since) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (block.type === "text" && block.text.trim()) return true;
			if (block.type === "toolCall") {
				if (orPose && POSE_TOOLS.includes(block.name)) return true;
				if (!failed.has(block.id) && sendToUserText(block) !== undefined) return true;
			}
		}
	}
	return false;
}

/** RC9: the turn answers a work submission / hint request, yet nothing in it
 *  is learner-visible prose and no question or task was posed. */
export function silentAfterSubmission(messages: readonly LhMessage[]): boolean {
	const { boundary, since } = sinceInput(messages);
	if (boundary?.role !== "custom") return false;
	if (boundary.customType !== "work-submission" && boundary.customType !== "hint-request") return false;
	return !turnSpeaks(since, true);
}

/** A drawn submission (canvas task or practice thinking), or a hint request
 *  sent with a snapshot of the canvas, whose turn has no successful annotate
 *  ON THAT DRAWING yet: returns the drawing id to mark. A refused annotate, or
 *  one on another drawing, does not count. Drawing-less submissions and hint
 *  requests are exempt. */
export function unmarkedSubmission(messages: readonly LhMessage[]): string | undefined {
	const { boundary, since } = sinceInput(messages);
	if (boundary?.role !== "custom") return undefined;
	if (boundary.customType !== "work-submission" && boundary.customType !== "practice-thinking" && boundary.customType !== "hint-request") return undefined;
	const drawingId = (boundary.details as { drawingId?: unknown } | null | undefined)?.drawingId;
	if (typeof drawingId !== "string") return undefined;
	const onThis = new Set<string>();
	for (const m of since) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.name !== "annotate") continue;
			if ((block.arguments as { drawingId?: unknown } | undefined)?.drawingId === drawingId) onThis.add(block.id);
		}
	}
	for (const m of since) if (m.role === "toolResult" && m.toolName === "annotate" && !m.isError && onThis.has(m.toolCallId)) return undefined;
	return drawingId;
}

const PLAN_DIAGRAM = /```\s*mermaid|^\s*(?:graph|flowchart)\s+(?:TD|TB|LR|RL|BT)\b/im;

/** RC10(a): the probe-handoff (planning) turn wrote a plan-looking diagram
 *  but no plan_init succeeded. */
export function planWrittenAsProse(messages: readonly LhMessage[]): boolean {
	const { boundary, since } = sinceInput(messages);
	if (boundary?.role !== "custom" || boundary.customType !== "probe-handoff") return false;
	let diagram = false;
	for (const m of since) {
		if (m.role === "toolResult" && m.toolName === "plan_init") {
			const ok = (m.details as { ok?: unknown } | null | undefined)?.ok !== false;
			if (!m.isError && ok) return false;
		}
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content) if (block.type === "text" && PLAN_DIAGRAM.test(block.text)) diagram = true;
		}
	}
	return diagram;
}

/** At most one steer per turn: the first matching rule wins. `done` is the
 *  caller's per-turn flag holder. */
export function nextNudge(messages: readonly LhMessage[], done: { used: boolean }): string | undefined {
	if (done.used) return undefined;
	// The mark steer also asks for the plain-text reply when the turn has
	// none, so it covers the silent-turn case for a drawn submission or hint;
	// after visible prose it asks only for the marks.
	const unmarked = unmarkedSubmission(messages);
	const { boundary, since } = sinceInput(messages);
	const steer = boundary?.role === "custom" && boundary.customType === "hint-request" ? hintMarkSteer : markSteer;
	const text =
		unmarked !== undefined
			? steer(unmarked, turnSpeaks(since, false))
			: silentAfterSubmission(messages)
				? SILENT_TURN_STEER
				: planWrittenAsProse(messages)
					? PLAN_INIT_STEER
					: undefined;
	if (text !== undefined) done.used = true;
	return text;
}

/** RC9: retry a step ONCE when it ends in an error with no content and the
 *  learner did not abort. Only the "start" event may precede the error. */
/** Only transient-looking failures are worth a second request: an abort or
 *  timeout nobody asked for, a dropped connection, a 5xx/429, or no message
 *  at all. A server that answered with a 4xx body would fail identically. */
function isTransient(message: string | undefined): boolean {
	if (!message?.trim()) return true;
	return /abort|timed? ?out|timeout|fetch failed|network|econn|socket|terminated|premature|overloaded|\b(?:408|429|5\d\d)\b/i.test(message);
}

export function withEmptyErrorRetry(inner: StreamFn): StreamFn {
	let retried = false;
	return async (model, context, options) => {
		const first = await inner(model, context, options);
		const out = createAssistantMessageEventStream();
		void (async () => {
			try {
				const held: AssistantMessageEvent[] = [];
				let live = false;
				for await (const event of first) {
					if (live) {
						out.push(event);
						continue;
					}
					if (event.type === "start") {
						held.push(event);
						continue;
					}
					const empty =
						event.type === "error" &&
						event.error.content.length === 0 &&
						!retried &&
						isTransient(event.error.errorMessage) &&
						options?.signal?.aborted !== true;
					if (empty) {
						retried = true;
						const second = await inner(model, context, options);
						for await (const e of second) out.push(e);
						return;
					}
					live = true;
					for (const h of held) out.push(h);
					out.push(event);
				}
				for (const h of held) out.push(h);
			} catch (err) {
				console.error("[stream-retry] failed:", err);
				// Settle the stream: without a terminal event result() never
				// resolves and the pi loop hangs the turn. The inner stream
				// throwing would have surfaced as an error step; so does this.
				const error: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
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
				out.push({ type: "error", reason: "error", error });
			} finally {
				out.end();
			}
		})();
		return out;
	};
}
