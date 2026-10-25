import type { GraphGroupBy, GraphNode, ProvenancePoint, SnapshotDocument } from "./contracts/graph.ts";
import { topicKey } from "./topic-key.ts";
import { stripModelValueDebris } from "./value-debris.ts";

/**
 * Selection-facing chain views — pure + browser-safe (the shell's chain
 * table consumes these; the barrel exports them). Born in the practice
 * contracts (2026-09-29), orphaned onto their own module when the batch
 * practice module was replaced by practice sessions (2026-10-04).
 */

/** One reasoning chain — a selection-facing VIEW of stored follows-edges:
 *  all edges into one conclusion, as premises → that conclusion. Singleton
 *  chains (premises: []) carry edge-less nodes. */
export interface ReasoningChain {
	/** The chain's identity — the CONCLUSION node's id (chains group by
	 *  conclusion, so the two are one). */
	id: string;
	/** Premise node ids — every follows-edge source into the conclusion,
	 *  sorted. Empty = a singleton chain (an edge-less node). */
	premises: string[];
	/** The conclusion node id (=== id; mirrored so renderings read
	 *  "premises → conclusion" without indirection). */
	conclusion: string;
}

/** The stored chains filtered to a selection (chains-primary, owner
 *  2026-09-30): a chain rides along iff its conclusion AND every premise
 *  are selected; a node in no surviving chain is a singleton chain
 *  (premises: []). Premise-only nodes whose chain was excluded are
 *  singletons — the same inclusion law as the pre-chains edge grouping.
 *  Every stored chain keeps its OWN id (arg_…) — two independent
 *  arguments for one conclusion stay distinct. Deterministic: chains
 *  sorted by id, premises sorted. */
export function chainsForSelection(
	nodes: ReadonlyArray<Pick<{ id: string }, "id">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): ReasoningChain[] {
	const selected = new Set(nodes.map((n) => n.id));
	const chained = new Set<string>();
	const included: ReasoningChain[] = [];
	for (const chain of chains) {
		if (!selected.has(chain.conclusion)) continue;
		if (!chain.premises.every((premise) => selected.has(premise))) continue;
		included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
		chained.add(chain.conclusion);
		for (const premise of chain.premises) chained.add(premise);
	}
	for (const node of nodes) {
		if (!chained.has(node.id)) {
			included.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}
	return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A chain as one world-facing line — the propositions' NAMES joined
 *  by the derivation arrow: "Premise one, Premise two → Conclusion"; a
 *  singleton shows its "(no premises)" marker. Pure + browser-safe.
 *  Unknown ids fall back to the raw id (honest, never guessed).
 *  Premises sort by id — the same determinism law as chainsForSelection. */
/** Resolve ONE target string to a canonical proposition id (owner round
 *  9, 2026-10-05 — the mastery-trace contract): id first (exact), then
 *  name (case-insensitive, trimmed — names are presentational handles,
 *  not unique; an ambiguous name resolves to the FIRST node in store
 *  order). Returns null when nothing matches — the caller rejects.
 *  Validation set is the WHOLE graph, not the session's picks: pickless
 *  sessions and future graph-tools poses stay valid. The debris strip
 *  (whitehead, 2026-10-09) heals copy-syntax (`:node-id`, quoted ids)
 *  before matching — targets are membership values like correctAnswer. */
export function resolveTargetId(
	target: string,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): string | null {
	const t = stripModelValueDebris(target);
	if (t.length === 0) return null;
	if (nodes.some((n) => n.id === t)) return t;
	const lower = t.toLowerCase();
	for (const n of nodes) {
		if (stripModelValueDebris(n.name).toLowerCase() === lower) return n.id;
	}
	return null;
}

export function formatChainLine(
	chain: Pick<ReasoningChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== ""
		? `${premises} → ${nameOf(chain.conclusion)}`
		: `${nameOf(chain.conclusion)} (no premises)`;
}

// ─── the chain table's grouping (PR H) ───────────────────────────────────────

/** One folder of the chain table. Leaf chains hang off `chains`; deeper
 *  levels (document -> section in source mode for documents; topic ->
 *  document -> section in topic mode) hang off `children`. `nodeIds` is the
 *  union over the whole subtree - what the folder's checkbox selects. */
export interface ChainGroup {
	/** Unique across the tree (a path of ids). Top-level source groups keep
	 *  the plain birth-source id, like before. */
	key: string;
	label: string | null;
	kind: "chat" | "notes" | "document" | "topic" | "section" | null;
	chains: ReasoningChain[];
	children: ChainGroup[];
	nodeIds: string[];
	newestCreatedAt: string;
}

/**
 * Group the visible chains for the chain table. A chain lives where its
 * CONCLUSION was born (owner ruling) - its birth source, and for a document
 * the section recorded on that provenance point.
 *
 *   source mode   chat / notes  -> chains
 *                 document      -> section -> chains
 *   topic mode    topic         -> document -> section -> chains
 *                 (a conclusion with no topic falls back to its source group)
 *
 * The topic is the conclusion's FIRST topic - the same home topic the
 * snapshot's clusters use.
 */
export function groupChains(args: {
	chains: readonly ReasoningChain[];
	nodes: ReadonlyMap<string, GraphNode>;
	groupBy: GraphGroupBy;
	sessions: Readonly<Record<string, string>>;
	fileSources: Readonly<Record<string, string>>;
	nodeTopics: Readonly<Record<string, string[]>>;
	documents: Readonly<Record<string, SnapshotDocument>>;
}): ChainGroup[] {
	const { nodes, groupBy, sessions, fileSources, nodeTopics, documents } = args;
	const top = new Map<string, ChainGroup>();
	const make = (key: string, label: string | null, kind: ChainGroup["kind"]): ChainGroup => ({
		key,
		label,
		kind,
		chains: [],
		children: [],
		nodeIds: [],
		newestCreatedAt: "",
	});
	const child = (parent: ChainGroup, key: string, label: string | null, kind: ChainGroup["kind"]): ChainGroup => {
		let found = parent.children.find((c) => c.key === key);
		if (!found) {
			found = make(key, label, kind);
			parent.children.push(found);
		}
		return found;
	};
	for (const chain of args.chains) {
		const conclusion = nodes.get(chain.conclusion);
		const point = conclusion?.provenance[0];
		const birth = point?.chatId ?? null;
		const topic = groupBy === "topic" ? nodeTopics[chain.conclusion]?.[0] : undefined;
		const doc = birth === null ? undefined : documents[birth];
		const sourceLabel = birth === null ? null : (sessions[birth] ?? fileSources[birth] ?? null);
		const sourceKind: ChainGroup["kind"] =
			birth === null ? null : doc ? "document" : sessions[birth] !== undefined ? "chat" : fileSources[birth] !== undefined ? "notes" : null;

		// The path of folders from the top down to the leaf that holds the chain.
		const path: ChainGroup[] = [];
		let root: ChainGroup;
		if (topic !== undefined) {
			const tkey = `topic:${topicKey(topic)}`;
			root = top.get(tkey) ?? make(tkey, topic, "topic");
			top.set(tkey, root);
			path.push(root);
			path.push(child(root, `${tkey}/${birth ?? "\0unlabeled"}`, sourceLabel, sourceKind));
		} else {
			const skey = birth ?? "\0unlabeled";
			root = top.get(skey) ?? make(skey, sourceLabel, sourceKind);
			top.set(skey, root);
			path.push(root);
		}
		const sourceGroup = path[path.length - 1]!;
		const section = doc && point?.section !== undefined ? doc.sections[point.section] : undefined;
		if (doc && section && point?.section !== undefined) {
			const pages =
				section.pageFrom === undefined
					? ""
					: section.pageTo === undefined || section.pageTo === section.pageFrom
						? ` · p.${section.pageFrom}`
						: ` · pp.${section.pageFrom}–${section.pageTo}`;
			path.push(
				child(sourceGroup, `${sourceGroup.key}/${point.section}`, `§ ${section.headingPath.join(" › ") || "(preamble)"}${pages}`, "section"),
			);
		}
		path[path.length - 1]!.chains.push(chain);
		for (const group of path) {
			for (const id of [...chain.premises, chain.conclusion]) {
				if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
				const createdAt = nodes.get(id)?.createdAt ?? "";
				if (createdAt > group.newestCreatedAt) group.newestCreatedAt = createdAt;
			}
		}
	}
	return [...top.values()];
}

/** The detail card's line for a node that came from a stored document:
 *  "<title> · §<section heading> · p.N", plus the page to deep-link to
 *  (/documents/<id>#p-N). The section and page parts are simply absent for
 *  provenance that predates them (an adopted old import). */
export function documentCitation(doc: SnapshotDocument, point: Pick<ProvenancePoint, "section" | "pageFrom">): { label: string; page?: number } {
	const section = point.section === undefined ? undefined : doc.sections[point.section];
	const heading = section?.headingPath[section.headingPath.length - 1];
	const page = point.pageFrom ?? section?.pageFrom;
	return {
		label: [doc.title, heading !== undefined ? `§${heading}` : null, page !== undefined ? `p.${page}` : null]
			.filter((part): part is string => part !== null)
			.join(" · "),
		...(page !== undefined ? { page } : {}),
	};
}
