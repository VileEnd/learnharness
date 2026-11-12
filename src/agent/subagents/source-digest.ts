import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { DerivedGraph } from "../../core/graph.ts";
import type { GraphChain, GraphNode } from "../../core/contracts.ts";
import { createPropositionCandidateSearch } from "../../core/proposition-candidates.ts";
import { viewTokens } from "../../core/coverage.ts";

// ── the same-source digest (owner, 2026-09-30 evening) ──
//
// Serialized digest-aware extraction REPLACED the spine stage (owner
// ruling after the live test: the post-hoc assembly pass added
// complexity without perceptible gain — the extractor itself is the
// assembler when it can see what its source has already yielded). Pure
// string fold over the derived graph; "" when the source owns nothing
// yet (the first stretch runs bare). Ids ride VERBATIM — that is what
// the extractor references in its chains (the merger's mixed-namespace
// resolution passes them through).
export function sourceDigest(graph: DerivedGraph, sourceId: string): string {
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
	const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
	if (ours.length === 0 && ourChains.length === 0) return "";
	const lines: string[] = [];
	lines.push("THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):");
	for (const n of ours) lines.push(fullLine(n));
	if (ourChains.length > 0) {
		lines.push("DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):");
		for (const c of ourChains) lines.push(chainLine(c, nameOf));
	}
	return lines.join("\n");
}

// ── the bounded digest (audit B4, owner ruling 2026-11-12: a compact index plus search) ──
//
// The full digest grows with everything a source has yielded, so a long
// document's late chunks paid for the whole book again on every call. Under
// a token budget (graph.extractionDigestTokens) it degrades in tiers, and
// every earlier idea stays reachable in each of them:
//
//   full    the digest fits: today's text, byte for byte, no extra tools.
//   index   every idea keeps one line (id | name); the ideas of the chunk's
//           own section, then the newest, are upgraded to today's full
//           entry (id | name | statement) with the derivations that conclude
//           in them, while the budget lasts.
//   topics  even the one-line index is over the budget: the nearest ideas in
//           full as above, the others counted per topic, and the extractor
//           gets search_ideas / open_idea over the source's ideas.
//
// Tokens are the pipeline's estimate (chars/4, ceil — core/coverage.ts
// viewTokens, the counter behind graph.extractionChunkTokens), so a digest
// of at most 4 × budget characters is within the budget.

export type DigestTier = "full" | "index" | "topics";

export interface BoundedDigest {
	text: string;
	tier: DigestTier;
}

export interface DigestBudget {
	budgetTokens: number;
	/** The section ids of the stretch being read (document door): earlier
	 *  ideas from those sections keep their full statement first. */
	sectionIds?: ReadonlySet<string>;
	/** nodeId -> its topics, home topic first (core/topics.ts topicsByNode).
	 *  Read only when the topics tier is reached. */
	topicsOf?: () => ReadonlyMap<string, readonly string[]>;
}

/** The two tools the topics tier names; the prompt cites these verbatim. */
export const SEARCH_IDEAS_TOOL = "search_ideas";
export const OPEN_IDEA_TOOL = "open_idea";

/** How long a one-line index label may run (name, or the statement's start). */
const INDEX_LABEL_CHARS = 60;
/** At most this share of the budget goes to the per-topic counts. */
const TOPIC_INDEX_SHARE = 0.5;
/** Tool results are bounded: hits per search, and characters per result. */
const SEARCH_HITS = 8;
const TOOL_RESULT_CHARS = 6000;
const OPEN_ALIASES = 5;
const OPEN_CHAINS = 10;
const NO_TOPIC = "(no topic)";

const INDEX_HEADER =
	"THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim). It is too long " +
	"to show whole: the ideas nearest this stretch keep their full statement, every other idea shows only its id and " +
	"name — reference those ids verbatim just the same:";
const topicsHeader = (others: number) =>
	"THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim). It is too large " +
	`to list: the ideas nearest this stretch are shown in full, the other ${others} are counted by topic below. Before ` +
	`you add an idea or a derivation that may already be there, look it up: ${SEARCH_IDEAS_TOOL} finds this source's ` +
	`earlier ideas by their words, ${OPEN_IDEA_TOOL} shows one in full by its id. The ids those tools return belong to ` +
	"THE GRAPH SO FAR — reference them verbatim just the same:";
const TOPIC_INDEX_HEADER = "OTHER IDEAS BY TOPIC (topic: number of ideas):";
const COMPACT_DERIVATIONS_HEADER =
	"DERIVATIONS ALREADY RECORDED for the ideas shown in full (build on these; do not re-derive them):";

function fullLine(n: GraphNode): string {
	return `  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function indexLine(n: GraphNode): string {
	return `  ${n.id} | ${clip(n.name.trim() === "" ? n.statement : n.name, INDEX_LABEL_CHARS)}`;
}

function chainLine(c: GraphChain, nameOf: ReadonlyMap<string, string>): string {
	const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
	return `  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${names} ⇒ ${nameOf.get(c.conclusion) ?? c.conclusion}`;
}

/** Characters of `lines` joined by newlines (what the prompt carries). */
const charsOf = (lines: readonly string[]): number => lines.reduce((sum, l) => sum + l.length, 0) + Math.max(0, lines.length - 1);

function sourceSlice(graph: DerivedGraph, sourceId: string) {
	return {
		ours: graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId)),
		ourChains: graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId)),
		nameOf: new Map(graph.nodes.map((n) => [n.id, n.name])),
	};
}

/** The per-topic counts of `rest` (home topic only), largest first, cut to
 *  `capChars` with a closing "… more" line. Always within the cap when the
 *  cap holds the header and that line. A list that fits whole renders whole,
 *  so a subset of ideas whose whole list fit never renders longer than it. */
function topicIndex(rest: readonly GraphNode[], topicsOf: ReadonlyMap<string, readonly string[]>, capChars: number): { lines: string[]; truncated: boolean } {
	const counts = new Map<string, number>();
	for (const n of rest) {
		const topic = clip(topicsOf.get(n.id)?.[0] ?? NO_TOPIC, INDEX_LABEL_CHARS);
		counts.set(topic, (counts.get(topic) ?? 0) + 1);
	}
	const entries = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const whole = [TOPIC_INDEX_HEADER, ...entries.map(([topic, count]) => `  ${topic}: ${count}`)];
	if (charsOf(whole) <= capChars) return { lines: whole, truncated: false };
	const lines = [TOPIC_INDEX_HEADER];
	const moreLine = (topics: number, ideas: number) => `  … and ${topics} more topics: ${ideas} ideas`;
	const moreReserve = moreLine(entries.length, rest.length).length + 1;
	let used = TOPIC_INDEX_HEADER.length;
	// Invariant: after each kept line there is still room for the "… more"
	// line, so the cut never overshoots the cap.
	for (const [i, [topic, count]] of entries.entries()) {
		const line = `  ${topic}: ${count}`;
		if (used + 1 + line.length + moreReserve > capChars) {
			const left = entries.slice(i);
			lines.push(moreLine(left.length, left.reduce((sum, [, c]) => sum + c, 0)));
			return { lines, truncated: true };
		}
		lines.push(line);
		used += 1 + line.length;
	}
	return { lines, truncated: false };
}

export function boundedSourceDigest(graph: DerivedGraph, sourceId: string, budget: DigestBudget): BoundedDigest {
	const full = sourceDigest(graph, sourceId);
	const budgetTokens = Math.max(0, Math.floor(budget.budgetTokens));
	if (viewTokens([full]) <= budgetTokens) return { text: full, tier: "full" };
	// Below, sizes are counted in characters: ceil(chars / 4) <= budget
	// exactly when chars <= 4 × budget.
	const budgetChars = budgetTokens * 4;

	const { ours, ourChains, nameOf } = sourceSlice(graph, sourceId);
	const inSection = (n: GraphNode) =>
		budget.sectionIds !== undefined &&
		n.provenance.some((pt) => pt.chatId === sourceId && pt.section !== undefined && budget.sectionIds!.has(pt.section));
	// Who earns a full statement first: the stretch's own section, then the
	// newest ideas (ledger order is creation order).
	const newestFirst = [...ours].reverse();
	const priority = [...newestFirst.filter(inSection), ...newestFirst.filter((n) => !inSection(n))];
	const chainsInto = new Map<string, GraphChain[]>();
	for (const c of ourChains) chainsInto.set(c.conclusion, [...(chainsInto.get(c.conclusion) ?? []), c]);

	/** Upgrade ideas in priority order while `room` characters last; each
	 *  upgrade costs `base(n)` plus, when they still fit, its derivations. */
	function upgrade(room: number, base: (n: GraphNode) => number) {
		const shown = new Set<string>();
		const chains = new Set<GraphChain>();
		for (const n of priority) {
			const cost = base(n);
			if (cost > room) continue;
			shown.add(n.id);
			room -= cost;
			const own = (chainsInto.get(n.id) ?? []).map((c) => ({ c, chars: chainLine(c, nameOf).length + 1 }));
			const ownChars = own.reduce((sum, x) => sum + x.chars, 0) + (chains.size === 0 && own.length > 0 ? COMPACT_DERIVATIONS_HEADER.length + 1 : 0);
			if (own.length > 0 && ownChars <= room) {
				for (const x of own) chains.add(x.c);
				room -= ownChars;
			}
		}
		return { shown, chains };
	}
	const derivations = (chains: ReadonlySet<GraphChain>) =>
		chains.size === 0 ? [] : [COMPACT_DERIVATIONS_HEADER, ...ourChains.filter((c) => chains.has(c)).map((c) => chainLine(c, nameOf))];

	// Tier 2: every idea as one line, the nearest upgraded to full entries.
	const indexBase = charsOf([INDEX_HEADER, ...ours.map(indexLine)]);
	if (indexBase <= budgetChars) {
		const { shown, chains } = upgrade(budgetChars - indexBase, (n) => fullLine(n).length - indexLine(n).length);
		const lines = [INDEX_HEADER, ...ours.map((n) => (shown.has(n.id) ? fullLine(n) : indexLine(n))), ...derivations(chains)];
		return { text: lines.join("\n"), tier: "index" };
	}

	// Tier 3: the nearest ideas in full, the rest counted per topic, and the
	// search tools for everything else.
	const topicsOf = budget.topicsOf?.() ?? new Map<string, readonly string[]>();
	const header = topicsHeader(ours.length);
	const topicCap = Math.floor(budgetChars * TOPIC_INDEX_SHARE);
	const allTopics = topicIndex(ours, topicsOf, topicCap);
	const topicReserve = allTopics.truncated ? topicCap : charsOf(allTopics.lines);
	const { shown, chains } = upgrade(budgetChars - header.length - topicReserve - 1, (n) => fullLine(n).length + 1);
	const rest = ours.filter((n) => !shown.has(n.id));
	const lines = [
		topicsHeader(rest.length),
		...ours.filter((n) => shown.has(n.id)).map(fullLine),
		...(rest.length > 0 ? topicIndex(rest, topicsOf, topicReserve).lines : []),
		...derivations(chains),
	];
	return { text: lines.join("\n"), tier: "topics" };
}

// ── the topics tier's tools: search the source's earlier ideas, open one ──

const searchInput = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "Words the earlier idea would use — a name, a term, a phrase of its statement. Plain words, no patterns.",
		}),
	},
	{ additionalProperties: false },
);
const openInput = Type.Object(
	{
		id: Type.String({ minLength: 1, description: 'The idea\'s id, verbatim ("n_…"), from THE GRAPH SO FAR or a search_ideas result.' }),
	},
	{ additionalProperties: false },
);

function bounded(lines: readonly string[]): string {
	const text = lines.join("\n");
	return text.length <= TOOL_RESULT_CHARS ? text : `${text.slice(0, TOOL_RESULT_CHARS - 1)}…`;
}

/** The extractor's lookup over its own source's earlier ideas (the topics
 *  tier only). Read-only and pure over the graph snapshot the digest was
 *  built from — a source's stretches run serially, so it is current. The
 *  search reuses the auditor's lexical candidate ranking
 *  (core/proposition-candidates.ts: BM25 over names, statements and
 *  aliases, the app's own tokenizer). */
export function createDigestTools(
	graph: DerivedGraph,
	sourceId: string,
	topicsOf: ReadonlyMap<string, readonly string[]>,
): Record<string, AgentTool<any>> {
	const { ours, ourChains, nameOf } = sourceSlice(graph, sourceId);
	const byId = new Map(ours.map((n) => [n.id, n]));
	let search: ReturnType<typeof createPropositionCandidateSearch> | undefined;
	return {
		[SEARCH_IDEAS_TOOL]: {
			name: SEARCH_IDEAS_TOOL,
			label: SEARCH_IDEAS_TOOL,
			description:
				`Search the ideas already extracted from THIS source (THE GRAPH SO FAR) by their words. Returns up to ${SEARCH_HITS} ` +
				"best matches, each as id | name | statement in full. Ranks word overlap across names, statements and other phrasings.",
			parameters: searchInput,
			execute: serverExecute(SEARCH_IDEAS_TOOL, searchInput, ({ query }): string => {
				search ??= createPropositionCandidateSearch(ours);
				const hits = search({ id: "query", name: "", statement: query, aliases: [] });
				if (hits.length === 0) return `No earlier idea of this source matches "${query}". Try other words, or treat the idea as new.`;
				const shown: string[] = [];
				let used = 0;
				for (const { node } of hits.slice(0, SEARCH_HITS)) {
					const line = fullLine(node);
					if (shown.length > 0 && used + line.length + 1 > TOOL_RESULT_CHARS - 200) break;
					shown.push(line);
					used += line.length + 1;
				}
				return bounded([`${shown.length} of ${hits.length} matching earlier ideas, best first (id | name | statement):`, ...shown]);
			}),
		},
		[OPEN_IDEA_TOOL]: {
			name: OPEN_IDEA_TOOL,
			label: OPEN_IDEA_TOOL,
			description:
				"Open one idea already extracted from THIS source by its id: its full statement, topics, other phrasings, and the " +
				"derivations recorded for it.",
			parameters: openInput,
			execute: serverExecute(OPEN_IDEA_TOOL, openInput, ({ id }): string => {
				const node = byId.get(id.trim());
				if (!node) return `"${id}" is not an idea of THE GRAPH SO FAR for this source. Use an id from the prompt or from ${SEARCH_IDEAS_TOOL}.`;
				const lines = [fullLine(node)];
				const topics = topicsOf.get(node.id) ?? [];
				if (topics.length > 0) lines.push(`Topics: ${topics.join(", ")}`);
				const aliases = node.aliases.filter((a) => a !== node.statement);
				if (aliases.length > 0) {
					lines.push("Also phrased as:");
					for (const a of aliases.slice(0, OPEN_ALIASES)) lines.push(`  - ${clip(a, 300)}`);
					if (aliases.length > OPEN_ALIASES) lines.push(`  … and ${aliases.length - OPEN_ALIASES} more`);
				}
				const listed = (title: string, chains: readonly GraphChain[]) => {
					if (chains.length === 0) return;
					lines.push(title);
					for (const c of chains.slice(0, OPEN_CHAINS)) lines.push(chainLine(c, nameOf));
					if (chains.length > OPEN_CHAINS) lines.push(`  … and ${chains.length - OPEN_CHAINS} more`);
				};
				listed("DERIVED FROM (recorded derivations of this idea):", ourChains.filter((c) => c.conclusion === node.id));
				listed("USED TO DERIVE:", ourChains.filter((c) => c.premises.includes(node.id)));
				return bounded(lines);
			}),
		},
	};
}
