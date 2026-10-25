/**
 * The "My knowledge" view's derivations (pure, node-bound through graph.ts /
 * topics.ts like them: the server imports this file directly, it is not in the
 * browser barrel). Two things, both derived at read time from the learner
 * snapshot and the graph ledgers:
 *
 *  - buildKnowledgeOverview: due today, open confusions, and the per-topic
 *    groups. Topic membership is the one the library and me/ use: the topics
 *    ledger folded through the alias table (a concept belongs to every topic
 *    it was tagged with).
 *  - knowledgeSubgraph: the graph of the concepts that have evidence, with
 *    edges from the chains among them only (the main graph's own deriveView
 *    over the subset, so a chain with an unchecked member drops).
 */

import type {
	ConceptState,
	GraphChain,
	GraphNode,
	KnowledgeConceptRef,
	KnowledgeOverview,
	KnowledgeTopicGroup,
	TopicRow,
} from "./contracts.ts";
import { deriveView } from "./graph.ts";
import { topicKey } from "./topic-key.ts";
import { canonicalTopic } from "./topics.ts";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Case-insensitive first, the raw text as the tie-break: a stable, locale-free name order. */
const cmpName = (a: string, b: string): number => cmp(a.toLowerCase(), b.toLowerCase()) || cmp(a, b);

type CheckedState = Exclude<ConceptState["state"], "not-yet-checked">;
const isChecked = (s: ConceptState | undefined): s is ConceptState & { state: CheckedState } =>
	s !== undefined && s.state !== "not-yet-checked";

/** The ids of the concepts that have evidence. */
export function checkedConceptIds(
	states: Readonly<Record<string, ConceptState>>,
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
): Set<string> {
	const out = new Set<string>();
	for (const n of nodes) if (isChecked(states[n.id])) out.add(n.id);
	return out;
}

export function buildKnowledgeOverview(input: {
	states: Readonly<Record<string, ConceptState>>;
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>;
	topicRows: readonly TopicRow[];
	aliases: Readonly<Record<string, string>>;
}): KnowledgeOverview {
	const { states, aliases } = input;
	const nameOf = new Map(input.nodes.map((n) => [n.id, n.name] as const));
	const ref = (id: string): KnowledgeConceptRef | null => {
		const s = states[id];
		if (!nameOf.has(id) || !isChecked(s)) return null;
		return { id, name: nameOf.get(id)!, state: s.state, due: s.due, ...(s.nextReviewAt ? { nextReviewAt: s.nextReviewAt } : {}) };
	};
	const checked = input.nodes.flatMap((n) => ref(n.id) ?? []);

	// ── due today: learning/solid and due, oldest due first ──
	const due = checked
		.filter((c) => c.due && (c.state === "learning" || c.state === "solid"))
		.sort((a, b) => cmp(a.nextReviewAt ?? "", b.nextReviewAt ?? "") || cmp(a.id, b.id));

	// ── open confusions, newest first ──
	const confusions = checked
		.flatMap((c) =>
			(states[c.id]?.openMisconceptions ?? []).map((m) => ({
				conceptId: c.id,
				conceptName: c.name,
				term: m.term,
				...(m.instead ? { instead: m.instead } : {}),
				...(m.why ? { why: m.why } : {}),
				at: m.at,
			})),
		)
		.sort((a, b) => cmp(b.at, a.at) || cmp(a.conceptId, b.conceptId) || cmp(a.term, b.term));

	// ── topics: the ledger through the alias table, deduped by key ──
	interface Acc {
		labels: Set<string>;
		ids: Set<string>;
	}
	const byKey = new Map<string, Acc>();
	const tagged = new Set<string>();
	for (const row of input.topicRows) {
		if (!nameOf.has(row.nodeId)) continue;
		const label = canonicalTopic(row.topic, aliases);
		const key = topicKey(label);
		if (key === "") continue;
		const acc = byKey.get(key) ?? { labels: new Set<string>(), ids: new Set<string>() };
		acc.labels.add(label);
		acc.ids.add(row.nodeId);
		byKey.set(key, acc);
		tagged.add(row.nodeId);
	}
	const groups: Array<{ label: string | null; ids: Set<string> }> = [...byKey.entries()]
		.sort((a, b) => cmp(a[0], b[0]))
		.map(([, acc]) => ({ label: [...acc.labels].sort(cmp)[0]!, ids: acc.ids }));
	const untagged = new Set(input.nodes.map((n) => n.id).filter((id) => !tagged.has(id)));
	if (untagged.size > 0) groups.push({ label: null, ids: untagged });

	const topics: KnowledgeTopicGroup[] = [];
	for (const g of groups) {
		const members = [...g.ids].flatMap((id) => ref(id) ?? []);
		if (members.length === 0) continue; // nothing checked in this topic: nothing to show
		const inState = (s: CheckedState) =>
			members.filter((m) => m.state === s).sort((a, b) => cmpName(a.name, b.name) || cmp(a.id, b.id));
		topics.push({
			label: g.label,
			total: g.ids.size,
			checked: members.length,
			activity: members.reduce((n, m) => n + (states[m.id]?.history.length ?? 0), 0),
			solid: inState("solid"),
			learning: inState("learning"),
			shaky: inState("shaky"),
		});
	}
	topics.sort(
		(a, b) =>
			b.activity - a.activity ||
			(a.label === null ? 1 : 0) - (b.label === null ? 1 : 0) ||
			cmpName(a.label ?? "", b.label ?? ""),
	);

	return { checkedCount: checked.length, due, confusions, topics };
}

/** The checked concepts' graph: the stored propositions among `checked`, and
 *  the main graph's derived view over them (chains with an unchecked member
 *  drop; multi-premise chains mint their implication node as usual). */
export function knowledgeSubgraph(
	graph: { nodes: readonly GraphNode[]; chains: readonly GraphChain[] },
	checked: ReadonlySet<string>,
): ReturnType<typeof deriveView> {
	return deriveView({
		nodes: graph.nodes.filter((n) => checked.has(n.id)),
		chains: graph.chains.filter((c) => checked.has(c.conclusion) && c.premises.every((p) => checked.has(p))) as GraphChain[],
	});
}
