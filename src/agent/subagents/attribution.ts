/**
 * The attribution agent: links the graded questions of ONE teaching session
 * that carry no `concepts` tag to the concepts they test. Questions about
 * material born in the same session cannot be tagged at ask time (the
 * concepts do not exist yet), so this runs after extraction, per chat.
 *
 * A cheap-slot, single-submit call beside the topic agents (it rides the
 * describer's role: same slot, same key gate). LLM judgment with code around
 * it: the model can only PICK from the offered concept ids, every item must
 * get an entry (an empty list is a real answer: the question is off the map),
 * and a violation returns to the model as an error result to retry on. The
 * ledger append is the caller's job; a failure here appends nothing.
 */

import { Type, type Static } from "typebox";
import { ROLE_SLOT, ModelsNotConfiguredError, ProviderKeyMissingError } from "../../core/settings.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import type { DescriberDeps } from "./describe.ts";

/** Items per call (keeps the output small enough for a cheap model to keep every id straight). */
export const ATTRIBUTION_BATCH_ITEMS = 20;
/** Concepts one question may be linked to. */
export const MAX_CONCEPTS_PER_ITEM = 3;

export interface AttributionItem {
	toolCallId: string;
	question: string;
	/** The correct answer in words ("" when unknown). */
	correct?: string;
	/** What the learner answered (or "I don't know"). */
	answer: string;
	/** How it counted, in words: "correct", "miss", "partly", ... */
	outcome: string;
	/** The concepts this item may be linked to (the model can only pick from these). */
	candidates: AttributionConcept[];
}

export interface AttributionConcept {
	id: string;
	name: string;
	statement: string;
}

export interface AttributionLink {
	toolCallId: string;
	conceptIds: string[];
}

const attributionSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			toolCallId: Type.String({ description: "The item's id, verbatim." }),
			conceptIds: Type.Array(Type.String(), {
				description: `Zero to ${MAX_CONCEPTS_PER_ITEM} concept ids from the CONCEPTS list, verbatim: the ones the question tests. Empty when none fits.`,
			}),
		}),
		{ description: "One entry per item." },
	),
});

const ATTRIBUTION_INSTRUCTIONS = `You link a learner's graded questions to the concepts they test. You get the CONCEPTS found in the learner's library (id | name | statement) and the ITEMS asked in a session (id | question | correct answer | his answer | how it counted | candidate concept ids). For every item decide which concepts (at most ${MAX_CONCEPTS_PER_ITEM}) the question actually tests, meaning the ideas someone needs to answer it correctly, and submit them in one attribute_items call with an entry per item. Pick only from an item's own candidate ids, copied verbatim. If no concept fits an item, give it an empty list: that is a real answer, not a gap to fill.`;

export interface Attributor {
	/** item -> concept ids (from each item's own candidates), batched. Every item gets an entry (possibly empty);
	 *  a model failure rejects and nothing is returned. `chatId` is the session's (request log). */
	runAttribution(
		items: readonly AttributionItem[],
		signal?: AbortSignal,
		chatId?: string,
	): Promise<AttributionLink[]>;
}

export function createAttributor(deps: DescriberDeps): Attributor {
	function engine(chatId: string | undefined) {
		const e = deps.engineFor("describer", { purpose: "attribution", ...(chatId && { chatId }) });
		if (!e) throw new ModelsNotConfiguredError([ROLE_SLOT.describer]);
		const refusal = deps.providerKeyMissing?.(e.model.provider, ROLE_SLOT.describer);
		if (refusal) throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
		return e;
	}
	return {
		async runAttribution(items, signal, chatId) {
			// Items with no candidates are off the map: no model call needed for them.
			const asked = items.filter((i) => i.candidates.length > 0);
			const out: AttributionLink[] = items.filter((i) => i.candidates.length === 0).map((i) => ({ toolCallId: i.toolCallId, conceptIds: [] }));
			for (let i = 0; i < asked.length; i += ATTRIBUTION_BATCH_ITEMS) {
				const batch = asked.slice(i, i + ATTRIBUTION_BATCH_ITEMS);
				const candidatesOf = new Map(batch.map((b) => [b.toolCallId, new Set(b.candidates.map((c) => c.id))]));
				const concepts = [...new Map(batch.flatMap((b) => b.candidates).map((c) => [c.id, c])).values()];
				const batchIds = new Set(batch.map((b) => b.toolCallId));
				const value = await runSubmitAgent<Static<typeof attributionSchema>>({
					role: "describer",
					toolName: "attribute_items",
					toolDescription: "Submit each item's concept ids.",
					parameters: attributionSchema,
					fill: (input) => ({
						links: Array.isArray(input.links)
							? input.links.map((l: { toolCallId?: unknown; conceptIds?: unknown }) => ({
									toolCallId: String(l.toolCallId ?? ""),
									conceptIds: Array.isArray(l.conceptIds) ? l.conceptIds.map((c) => String(c).trim()) : [],
								}))
							: [],
					}),
					validate: (v) => {
						for (const l of v.links) {
							if (!batchIds.has(l.toolCallId)) return `links: "${l.toolCallId}" is not one of the listed item ids.`;
							const stray = l.conceptIds.find((c) => !candidatesOf.get(l.toolCallId)!.has(c));
							if (stray !== undefined) {
								return `links: concept id "${stray}" is not in the CONCEPTS list of item "${l.toolCallId}" - pick only from that item's candidate ids, copied verbatim.`;
							}
							if (l.conceptIds.length > MAX_CONCEPTS_PER_ITEM) {
								return `links: "${l.toolCallId}" has ${l.conceptIds.length} concepts - at most ${MAX_CONCEPTS_PER_ITEM}.`;
							}
						}
						const given = new Set(v.links.map((l) => l.toolCallId));
						const missing = batch.find((b) => !given.has(b.toolCallId));
						return missing ? `links: no entry for item "${missing.toolCallId}" - give every item an entry, with an empty conceptIds when no concept fits.` : null;
					},
					systemPrompt: ATTRIBUTION_INSTRUCTIONS,
					prompt:
						`CONCEPTS:\n${concepts.map((c) => `${c.id} | ${c.name} | ${c.statement.replace(/\s+/g, " ")}`).join("\n")}\n\nITEMS:\n` +
						batch
							.map(
								(b) =>
									`${b.toolCallId} | ${b.question.replace(/\s+/g, " ")} | ${(b.correct ?? "").replace(/\s+/g, " ")} | ${b.answer.replace(/\s+/g, " ")} | ${b.outcome} | ${b.candidates.map((c) => c.id).join(", ")}`,
							)
							.join("\n"),
					engine: engine(chatId),
					signal,
					onStep: () => {},
					neverSubmitted: "The attribution agent ended without submitting links.",
				});
				const byItem = new Map<string, Set<string>>();
				for (const l of value.links) {
					const set = byItem.get(l.toolCallId) ?? new Set<string>();
					for (const c of l.conceptIds) set.add(c);
					byItem.set(l.toolCallId, set);
				}
				for (const b of batch) out.push({ toolCallId: b.toolCallId, conceptIds: [...(byItem.get(b.toolCallId) ?? [])] });
			}
			return out;
		},
	};
}
