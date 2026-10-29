/**
 * The attribution service (learner model, evidence layer): links a teaching
 * session's graded-but-untagged questions to the concepts they test, and
 * records the result in the attribution ledger (LearnerStore, the sole
 * writer). Composition only; the judgment is the attribution agent's, the
 * item/ledger arithmetic is core/learner.ts's.
 *
 * Candidates come from the WHOLE library: each item's question + correct
 * answer is searched against the concept index (independent of extraction and
 * of the teacher's tagging), unioned with the chat's own propositions. An item
 * is attributable as soon as it is graded. A link row is appended whenever the
 * model picks concepts; an EXPLICIT EMPTY row (never sent again) only when
 * the item is coverage-eligible (its teaching has been extracted) or
 * extraction is off for the chat - otherwise nothing is appended and the item
 * is retried after the next merge, when the session's new concepts exist.
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
import { isPolicyRefusal, ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import type { AttributionConcept, Attributor } from "../agent/subagents/attribution.ts";

/** Candidates offered per item (library hits first, then the chat's own propositions). */
export const MAX_CANDIDATES_PER_ITEM = 12;
/** Library hits requested per item. */
export const LIBRARY_HITS_PER_ITEM = 8;
const QUERY_MAX_CHARS = 700;

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** The trailing debounce before a scheduled attribution runs. */
export const ATTRIBUTION_DEBOUNCE_MS = 30_000;

export interface AttributionDeps {
	chatStore: Pick<ChatStore, "getChat" | "listChats">;
	graphStore: Pick<GraphStore, "readNodes" | "readChains" | "readCoverage">;
	learnerStore: LearnerStore;
	attributor: Attributor;
	/** Library concept ids best matching a query (best first). Absent = the chat's own propositions only. */
	searchConcepts?: (query: string) => Promise<string[]>;
	/** Is graph extraction on? Off = an unmatched item gets its empty row at once (no merge will bring concepts). Default: on. */
	extractionEnabled?: () => boolean;
	now?: () => Date;
	debounceMs?: number;
}

export interface AttributionService {
	/** Attribute one chat now (serial per chat). Resolves to the rows appended; never rejects. */
	attributeChat(chatId: string): Promise<number>;
	/** Debounced attributeChat (the trigger entry point). */
	schedule(chatId: string): void;
	/** Attribute every chat with pending graded items, one after another (the admin backfill). */
	attributePending(): Promise<{ chats: number; rows: number }>;
	/** Does the chat have graded items still waiting for attribution? (Record-only, cheap.) */
	hasPendingItems(chatId: string): boolean;
}

export function createAttributionService(deps: AttributionDeps): AttributionService {
	const tails = new Map<string, Promise<unknown>>();
	// Items tried without a match, keyed to the chat's merge state (its coverage-ledger
	// size, which grows with every merge) when tried. In memory: a restart retries.
	const tried = new Map<string, number>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	async function run(chatId: string): Promise<number> {
		try {
			const record = deps.chatStore.getChat(chatId);
			if (!record) return 0;
			const coverage = deps.graphStore.readCoverage();
			const mergeState = coverage.filter((c) => c.chatId === chatId).length;
			const keyOf = (toolCallId: string) => `${chatId}\u0000${toolCallId}`;
			// Skip items already tried at this merge state: only a new merge can change the answer.
			const items = unattributedItems(record, deps.learnerStore.readAttributions()).filter((i) => tried.get(keyOf(i.toolCallId)) !== mergeState);
			if (items.length === 0) return 0;
			const nodes = new Map(getGraph(deps.graphStore).nodes.map((n) => [n.id, n]));
			const own = [...nodes.values()].filter((n) => n.provenance.some((p) => p.chatId === chatId));
			const toConcept = (id: string): AttributionConcept | null => {
				const n = nodes.get(id);
				return n ? { id: n.id, name: n.name, statement: n.statement } : null;
			};
			const withCandidates = [];
			for (const i of items) {
				const query = `${i.question} ${i.correct}`.replace(/\s+/g, " ").trim().slice(0, QUERY_MAX_CHARS);
				const found = deps.searchConcepts && query ? await deps.searchConcepts(query) : [];
				const library = found.slice(0, LIBRARY_HITS_PER_ITEM);
				// The chat's own propositions, ranked by word overlap with the question.
				const qWords = words(query);
				const ownRanked = own
					.map((n) => ({ n, hits: [...words(`${n.name} ${n.statement}`)].filter((w) => qWords.has(w)).length }))
					.sort((a, b) => b.hits - a.hits)
					.map((x) => x.n.id);
				const ids = [...new Set([...library, ...ownRanked])].slice(0, MAX_CANDIDATES_PER_ITEM);
				const candidates = ids.flatMap((id) => toConcept(id) ?? []);
				withCandidates.push({
					toolCallId: i.toolCallId,
					question: i.question,
					correct: i.correct,
					answer: i.answer,
					outcome: i.raw,
					candidates,
				});
			}
			const links = await deps.attributor.runAttribution(withCandidates, undefined, chatId);
			const byItem = new Map(links.map((l) => [l.toolCallId, l.conceptIds]));
			const finalEmpty = new Set(
				deps.extractionEnabled && !deps.extractionEnabled()
					? items.map((i) => i.toolCallId)
					: eligibleForAttribution(record, items, coverage).map((i) => i.toolCallId),
			);
			const at = (deps.now?.() ?? new Date()).toISOString();
			let appended = 0;
			for (const item of items) {
				const conceptIds = byItem.get(item.toolCallId) ?? [];
				if (conceptIds.length === 0 && !finalEmpty.has(item.toolCallId)) {
					tried.set(keyOf(item.toolCallId), mergeState);
					continue;
				}
				deps.learnerStore.appendAttribution({ chatId, toolCallId: item.toolCallId, conceptIds, at });
				appended++;
			}
			return appended;
		} catch (err) {
			// BYOK: an unconfigured or keyless cheap slot, or a per-user policy
			// refusal (cap reached, model not allowed), skips quietly (the items stay
			// unattributed and the next trigger retries); anything else is logged.
			if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError || isPolicyRefusal(err)) {
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
		async attributePending() {
			let chats = 0;
			let rows = 0;
			for (const c of deps.chatStore.listChats()) {
				if (c.kind === "practice" || !this.hasPendingItems(c.id)) continue;
				const n = await attributeChat(c.id);
				rows += n;
				if (n > 0) chats++;
			}
			return { chats, rows };
		},
		hasPendingItems(chatId) {
			const record = deps.chatStore.getChat(chatId);
			return !!record && unattributedItems(record, deps.learnerStore.readAttributions()).length > 0;
		},
	};
}
