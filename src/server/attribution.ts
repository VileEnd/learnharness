/**
 * The attribution service (learner model, evidence layer): links a teaching
 * session's graded-but-untagged questions to the concepts they test, and
 * records the result in the attribution ledger (LearnerStore, the sole
 * writer). Composition only; the judgment is the attribution agent's, the
 * item/ledger arithmetic is core/learner.ts's.
 *
 * Scope is ONE chat: its graded, untagged, unattributed items x the
 * propositions with provenance in that chat. One row is appended per item,
 * INCLUDING an explicit empty one (an off-map item is never sent again).
 * Nothing is appended unless the whole attribution succeeded.
 *
 * Triggers (wired by the callers, never in tests unless driven explicitly):
 * after each merge for the chat, and when a turn settles on a chat with new
 * graded items. `schedule` debounces them (trailing, per chat); runs are
 * serial per chat; every error is contained here (logged, nothing appended)
 * so a side channel can never reach the turn.
 */

import { getGraph } from "../core/graph.ts";
import { eligibleForAttribution, unattributedItems } from "../core/learner.ts";
import type { ChatStore, GraphStore, LearnerStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import type { Attributor } from "../agent/subagents/attribution.ts";

/** The trailing debounce before a scheduled attribution runs. */
export const ATTRIBUTION_DEBOUNCE_MS = 30_000;

export interface AttributionDeps {
	chatStore: Pick<ChatStore, "getChat">;
	graphStore: Pick<GraphStore, "readNodes" | "readChains" | "readCoverage">;
	learnerStore: LearnerStore;
	attributor: Attributor;
	now?: () => Date;
	debounceMs?: number;
}

export interface AttributionService {
	/** Attribute one chat now (serial per chat). Resolves to the rows appended; never rejects. */
	attributeChat(chatId: string): Promise<number>;
	/** Debounced attributeChat (the trigger entry point). */
	schedule(chatId: string): void;
	/** Does the chat have graded items still waiting for attribution? (Record-only, cheap.) */
	hasPendingItems(chatId: string): boolean;
}

export function createAttributionService(deps: AttributionDeps): AttributionService {
	const tails = new Map<string, Promise<unknown>>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	async function run(chatId: string): Promise<number> {
		try {
			const record = deps.chatStore.getChat(chatId);
			if (!record) return 0;
			// Only items whose preceding teaching has been extracted: a premature
			// (possibly empty) row would be final.
			const items = eligibleForAttribution(record, unattributedItems(record, deps.learnerStore.readAttributions()), deps.graphStore.readCoverage());
			if (items.length === 0) return 0;
			const graph = getGraph(deps.graphStore);
			const concepts = graph.nodes
				.filter((n) => n.provenance.some((p) => p.chatId === chatId))
				.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
			// No propositions born or linked in this chat yet: leave the items
			// unattributed (a later merge may bring their concepts), append nothing.
			if (concepts.length === 0) return 0;
			const links = await deps.attributor.runAttribution(
				items.map((i) => ({ toolCallId: i.toolCallId, question: i.question, answer: i.answer, outcome: i.raw })),
				concepts,
			);
			const byItem = new Map(links.map((l) => [l.toolCallId, l.conceptIds]));
			const at = (deps.now?.() ?? new Date()).toISOString();
			for (const item of items) {
				deps.learnerStore.appendAttribution({ chatId, toolCallId: item.toolCallId, conceptIds: byItem.get(item.toolCallId) ?? [], at });
			}
			return items.length;
		} catch (err) {
			// BYOK: an unconfigured or keyless cheap slot skips quietly (the items stay
			// unattributed and the next trigger retries); anything else is logged.
			if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
				console.info(`[chat ${chatId}] attribution skipped - ${err.envelope.error}`);
			} else {
				console.error(`[chat ${chatId}] attribution failed:`, err);
			}
			return 0;
		}
	}

	function attributeChat(chatId: string): Promise<number> {
		const next = (tails.get(chatId) ?? Promise.resolve()).then(() => run(chatId));
		const tail: Promise<number> = next.finally(() => {
			if (tails.get(chatId) === tail) tails.delete(chatId);
		});
		tails.set(chatId, tail);
		return next;
	}

	return {
		attributeChat,
		schedule(chatId) {
			const pending = timers.get(chatId);
			if (pending) clearTimeout(pending);
			const timer = setTimeout(() => {
				timers.delete(chatId);
				void attributeChat(chatId);
			}, deps.debounceMs ?? ATTRIBUTION_DEBOUNCE_MS);
			timer.unref?.();
			timers.set(chatId, timer);
		},
		hasPendingItems(chatId) {
			const record = deps.chatStore.getChat(chatId);
			return !!record && unattributedItems(record, deps.learnerStore.readAttributions()).length > 0;
		},
	};
}
