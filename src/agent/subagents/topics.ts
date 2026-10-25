/**
 * The topic agents (PR H): two small cheap-slot, single-submit calls beside
 * the describer (they ride its `describer` background role - the same cheap
 * slot, the same key gate; there is no new role to configure).
 *
 *   canonicalize  maps a NEW document's topics onto the topics the library
 *                 already knows, across languages and inflections
 *                 ("Semaphor" / "Semaphoren" / "semaphores" -> one). The
 *                 service stores the result as the alias table BEFORE
 *                 extraction; the merger then applies it deterministically.
 *   tagNodes      adopts an old import: given the document's canonical
 *                 topics and the statements of the nodes an earlier
 *                 extraction already produced, assigns topics to nodes. The
 *                 rows reach the ledger only through the merger.
 *
 * Neither agent sees a filename. Both are LLM judgment with code around it:
 * the answers are validated against the offered vocabulary, so a model can
 * only pick, never invent.
 */

import { Type, type Static } from "typebox";
import {
	ROLE_SLOT,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
} from "../../core/settings.ts";
import { MAX_TOPICS_PER_PROPOSITION } from "../../core/topics.ts";
import { topicKey } from "../../core/documents.ts";
import { runSubmitAgent, healStringifiedArrays } from "./submit-agent.ts";
import type { DescriberDeps } from "./describe.ts";

/** Nodes per tagging call (statements are short; this keeps a call small). */
export const TAG_BATCH_NODES = 40;

const canonicalizeSchema = Type.Object({
	mapping: Type.Array(
		Type.Object({
			topic: Type.String({ description: "One of the NEW topics, verbatim." }),
			canonical: Type.String({
				description:
					"The EXISTING topic it is the same subject as (verbatim), or the topic itself when no existing topic is the same subject.",
			}),
		}),
		{ description: "One entry per NEW topic." },
	),
});

const CANONICALIZE_INSTRUCTIONS = `You keep a learner's topic list tidy. A new document brings NEW topics; the library already has EXISTING topics. For each new topic decide whether it names the same subject as an existing topic - across languages, plurals and inflections ("Semaphor", "Semaphoren" and "semaphores" are one subject) - and submit one canonicalize_topics call with an entry per new topic: its canonical topic, copied verbatim from the existing list, or the new topic itself when nothing existing is the same subject. Related is not the same: "Mutex" and "Semaphoren" stay apart. If several new topics name one subject, give them the same canonical topic.`;

const tagSchema = Type.Object({
	assignments: Type.Array(
		Type.Object({
			id: Type.String({ description: "The node id, verbatim." }),
			topics: Type.Array(Type.String(), {
				description: `One to ${MAX_TOPICS_PER_PROPOSITION} topics from the TOPICS list, verbatim - the ones this idea belongs to.`,
			}),
		}),
		{ description: "One entry per node." },
	),
});

const TAG_INSTRUCTIONS = `You file ideas under topics. You get the TOPICS of one document and a list of the ideas (id | name | statement) that were extracted from it. For every idea, pick the one to ${MAX_TOPICS_PER_PROPOSITION} topics from the TOPICS list that it belongs to, copied verbatim, and submit them in one tag_nodes call with an entry per idea id. Use only topics from the list.`;

export interface TaggableNode {
	id: string;
	name: string;
	statement: string;
}

export interface Topicist {
	/** new topic -> canonical topic (an existing one, or itself). */
	canonicalize(newTopics: readonly string[], existing: readonly string[], signal?: AbortSignal): Promise<Record<string, string>>;
	/** node id -> its topics, batched; ids the model skipped are omitted. */
	tagNodes(
		topics: readonly string[],
		nodes: readonly TaggableNode[],
		signal?: AbortSignal,
	): Promise<{ nodeId: string; topics: string[] }[]>;
}

export function createTopicist(deps: DescriberDeps): Topicist {
	function engine() {
		const e = deps.engineFor("describer");
		if (!e) throw new ModelsNotConfiguredError([ROLE_SLOT.describer]);
		const refusal = deps.providerKeyMissing?.(e.model.provider, ROLE_SLOT.describer);
		if (refusal) throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
		return e;
	}
	return {
		async canonicalize(newTopics, existing, signal) {
			const identity = Object.fromEntries(newTopics.map((t) => [t, t]));
			if (newTopics.length === 0 || (existing.length === 0 && newTopics.length < 2)) return identity;
			const offered = new Set([...existing, ...newTopics].map(topicKey));
			const value = await runSubmitAgent<Static<typeof canonicalizeSchema>>({
				role: "describer",
				toolName: "canonicalize_topics",
				toolDescription: "Submit each new topic's canonical topic.",
				parameters: canonicalizeSchema,
				fill: (input) => ({
					mapping: Array.isArray(input.mapping)
						? input.mapping.map((m: { topic?: unknown; canonical?: unknown }) => ({
								topic: String(m.topic ?? "").trim(),
								canonical: String(m.canonical ?? "").trim(),
							}))
						: [],
				}),
				validate: (v) => {
					const bad = v.mapping.find((m) => !offered.has(topicKey(m.canonical)));
					return bad ? `mapping: "${bad.canonical}" is neither an existing topic nor one of the new topics - copy it verbatim from the lists.` : null;
				},
				systemPrompt: CANONICALIZE_INSTRUCTIONS,
				prompt: `EXISTING topics:\n${existing.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nNEW topics:\n${newTopics.map((t) => `- ${t}`).join("\n")}`,
				engine: engine(),
				signal,
				onStep: () => {},
				neverSubmitted: "The topic canonicalizer ended without submitting a mapping.",
				prepareArguments: healStringifiedArrays,
			});
			const out = { ...identity };
			const byKey = new Map(newTopics.map((t) => [topicKey(t), t]));
			for (const m of value.mapping) {
				const original = byKey.get(topicKey(m.topic));
				if (original !== undefined && m.canonical !== "") out[original] = m.canonical;
			}
			return out;
		},

		async tagNodes(topics, nodes, signal) {
			if (topics.length === 0 || nodes.length === 0) return [];
			const allowed = new Map(topics.map((t) => [topicKey(t), t]));
			const known = new Set(nodes.map((n) => n.id));
			const out: { nodeId: string; topics: string[] }[] = [];
			for (let i = 0; i < nodes.length; i += TAG_BATCH_NODES) {
				const batch = nodes.slice(i, i + TAG_BATCH_NODES);
				const batchIds = new Set(batch.map((n) => n.id));
				const value = await runSubmitAgent<Static<typeof tagSchema>>({
					role: "describer",
					toolName: "tag_nodes",
					toolDescription: "Submit each idea's topics.",
					parameters: tagSchema,
					fill: (input) => ({
						assignments: Array.isArray(input.assignments)
							? input.assignments.map((a: { id?: unknown; topics?: unknown }) => ({
									id: String(a.id ?? ""),
									topics: Array.isArray(a.topics) ? a.topics.map((t) => String(t).trim()) : [],
								}))
							: [],
					}),
					validate: (v) => {
						for (const a of v.assignments) {
							if (!batchIds.has(a.id)) return `assignments: "${a.id}" is not one of the listed idea ids.`;
							const stray = a.topics.find((t) => !allowed.has(topicKey(t)));
							if (stray !== undefined) return `assignments: topic "${stray}" is not in the TOPICS list - copy topics verbatim.`;
						}
						return null;
					},
					systemPrompt: TAG_INSTRUCTIONS,
					prompt:
						`TOPICS:\n${topics.map((t) => `- ${t}`).join("\n")}\n\nIDEAS:\n` +
						batch.map((n) => `${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`).join("\n"),
					engine: engine(),
					signal,
					onStep: () => {},
					neverSubmitted: "The topic tagger ended without submitting assignments.",
					prepareArguments: healStringifiedArrays,
				});
				for (const a of value.assignments) {
					if (!known.has(a.id)) continue;
					const mapped = a.topics.map((t) => allowed.get(topicKey(t))).filter((t): t is string => t !== undefined);
					if (mapped.length > 0) out.push({ nodeId: a.id, topics: mapped.slice(0, MAX_TOPICS_PER_PROPOSITION) });
				}
			}
			return out;
		},
	};
}
