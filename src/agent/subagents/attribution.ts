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
	/** What the learner answered (or "I don't know"). */
	answer: string;
	/** How it counted, in words: "correct", "miss", "partly", ... */
	outcome: string;
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

const ATTRIBUTION_INSTRUCTIONS = `You link a learner's graded questions to the concepts they test. You get the CONCEPTS of one teaching session (id | name | statement) and the ITEMS asked in it (id | question | his answer | how it counted). For every item decide which concepts (at most ${MAX_CONCEPTS_PER_ITEM}) the question actually tests, meaning the ideas someone needs to answer it correctly, and submit them in one attribute_items call with an entry per item. Copy concept ids verbatim from the list. If no concept fits an item, give it an empty list: that is a real answer, not a gap to fill.`;

export interface Attributor {
	/** item -> concept ids, batched. Every item gets an entry (possibly empty);
	 *  a model failure rejects and nothing is returned. */
	runAttribution(
		items: readonly AttributionItem[],
		concepts: readonly AttributionConcept[],
		signal?: AbortSignal,
	): Promise<AttributionLink[]>;
}

export function createAttributor(deps: DescriberDeps): Attributor {
	function engine() {
		const e = deps.engineFor("describer");
		if (!e) throw new ModelsNotConfiguredError([ROLE_SLOT.describer]);
		const refusal = deps.providerKeyMissing?.(e.model.provider, ROLE_SLOT.describer);
		if (refusal) throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
		return e;
	}
	return {
		async runAttribution(items, concepts, signal) {
			if (items.length === 0) return [];
			// No concepts to pick from: every item is off the map, no model call needed.
			if (concepts.length === 0) return items.map((i) => ({ toolCallId: i.toolCallId, conceptIds: [] }));
			const knownConcepts = new Set(concepts.map((c) => c.id));
			const out: AttributionLink[] = [];
			for (let i = 0; i < items.length; i += ATTRIBUTION_BATCH_ITEMS) {
				const batch = items.slice(i, i + ATTRIBUTION_BATCH_ITEMS);
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
							const stray = l.conceptIds.find((c) => !knownConcepts.has(c));
							if (stray !== undefined) return `links: concept id "${stray}" is not in the CONCEPTS list - copy ids verbatim.`;
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
							.map((b) => `${b.toolCallId} | ${b.question.replace(/\s+/g, " ")} | ${b.answer.replace(/\s+/g, " ")} | ${b.outcome}`)
							.join("\n"),
					engine: engine(),
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
