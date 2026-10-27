/**
 * The runaway-turn guard (owner decision 2026-10-27, "breaker + spend cap").
 * It overrides the older "maxTurns is gone" ruling ONLY as specified here:
 *
 *  1. IDENTICAL-FAILURE BREAKER. Within one turn, the same tool failing with
 *     the same canonicalized arguments for the 3rd time gets a final refusal;
 *     the tool is then refused immediately for the rest of the turn. Two more
 *     calls to it anyway end the turn cleanly (the same finishTurn "end" path
 *     the question stopper uses). Precedent: GUARD_MAX_REFUSALS (tools.ts).
 *  2. PER-TURN SPEND CAP. The cost of each assistant step (the injected
 *     `stepCost`, which the handler binds to the money channel's callCost)
 *     accumulates; at or over the cap the turn ends after the current step.
 *     Unknown cost counts as 0 - absent stays absent, nothing is invented.
 *
 * Counting is DERIVED from the turn's own tool results inside finishTurn, so
 * it covers every failure kind (schema validation errors never reach a tool's
 * execute). The state lives in this closure: per turn, never persisted - the
 * agents are stateless and rebuilt per turn. Successes are never counted and
 * reset nothing, so a long run of successful calls is untouched.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { canonicalJson } from "../core/canvas-core.ts";

/** Identical failures of one tool before the final refusal. */
export const BREAKER_FAILURE_LIMIT = 3;
/** Calls to the dropped tool, after the final refusal, that end the turn. */
export const BREAKER_EXTRA_CALLS = 2;

export const STUCK_NOTICE = "The tutor got stuck on a tool call; the turn was stopped. Send a message to continue.";

export function spendNotice(capUsd: number): string {
	return `This turn reached your spend limit of $${capUsd.toFixed(2)} (Settings → Agent). Send a message to continue.`;
}

export function finalRefusal(tool: string): string {
	return `This call has failed ${BREAKER_FAILURE_LIMIT} times with the same input. ${tool} is unavailable for the rest of this turn. Continue without it or end the turn.`;
}

export interface TurnGuardOptions {
	/** USD ceiling for this turn; absent = no cap. */
	spendCapUsd?: number;
	/** Cost of one assistant step; null/absent = unknown (counts as 0). */
	stepCost?: (usage: Usage) => number | null;
}

interface ToolCallBlock { type: string; id?: string; name?: string; arguments?: unknown }
interface ResultLike { toolCallId: string; isError?: boolean; content: unknown[] }
export interface GuardTurn {
	message: { content: ToolCallBlock[] };
	toolResults: ResultLike[];
}

export function createTurnGuard(opts: TurnGuardOptions = {}) {
	const failures = new Map<string, number>();
	const dropped = new Set<string>();
	let droppedCalls = 0;
	let spent = 0;
	let notice: string | undefined;

	return {
		/** Feed each billed assistant step's usage (message_end). */
		observeUsage(usage: Usage) {
			const cost = opts.stepCost?.(usage);
			if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) spent += cost;
		},
		/** Dropped tools never execute again this turn. */
		beforeToolCall(toolName: string): { block: true; reason: string } | undefined {
			return dropped.has(toolName) ? { block: true, reason: finalRefusal(toolName) } : undefined;
		},
		/** Run at finishTurn. Returns true when the turn must end; `notice()`
		 *  then holds the learner-facing line. `alreadyEnding`: another rule
		 *  (a posed question) ends the turn, so no notice is raised. */
		finishTurn(turn: GuardTurn, alreadyEnding = false): boolean {
			const byId = new Map(turn.toolResults.map((r) => [r.toolCallId, r]));
			let hadCalls = false;
			for (const block of turn.message.content) {
				if (block.type !== "toolCall" || block.name === undefined || block.id === undefined) continue;
				hadCalls = true;
				const result = byId.get(block.id);
				if (!result) continue;
				const refuse = () => {
					result.content = [{ type: "text", text: finalRefusal(block.name!) }];
				};
				if (dropped.has(block.name)) {
					droppedCalls++;
					refuse();
					continue;
				}
				if (result.isError !== true) continue;
				const key = `${block.name}\u0000${canonicalJson(block.arguments ?? {})}`;
				const n = (failures.get(key) ?? 0) + 1;
				failures.set(key, n);
				if (n >= BREAKER_FAILURE_LIMIT) {
					dropped.add(block.name);
					refuse();
				}
			}
			if (alreadyEnding) return false;
			if (droppedCalls >= BREAKER_EXTRA_CALLS) {
				notice = STUCK_NOTICE;
				return true;
			}
			// A step with no tool calls ends the run on its own - no notice.
			if (hadCalls && opts.spendCapUsd !== undefined && spent >= opts.spendCapUsd) {
				notice = spendNotice(opts.spendCapUsd);
				return true;
			}
			return false;
		},
		notice: () => notice,
	};
}

export type TurnGuard = ReturnType<typeof createTurnGuard>;
