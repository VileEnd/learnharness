/**
 * The one-off topic backfill (PR 4): concepts born in teaching sessions before
 * session extraction proposed topics have no topic row. This pass tags every
 * such node ONCE with the open-ended cheap-slot tagger (1-3 topics each,
 * existing labels preferred, new ones allowed), canonicalises the labels onto
 * the library's topics (alias table, under the alias lock) and appends the rows
 * through the extraction pipeline's merger entry point (applyTopicRows) - the
 * pipeline stays the sole graph writer. A node with a topic row is never
 * touched, so a second run finds nothing to do.
 *
 * Triggered only by the admin POST /api/graph/topics/backfill; never at boot
 * and never in tests. Runs in the background as one activity row; errors are
 * contained (logged, reported in the result) and stop the pass - rows already
 * merged stay, and the next call resumes with the nodes still untagged.
 */

import type { GraphStore } from "../core/ports.ts";
import { canonicalizeAndStoreTopics, canonicalTopics, knownTopics } from "../core/topics.ts";

/** Nodes per cheap-model call. A node is name + statement (~40 tokens), so a chunk
 *  is ~4k tokens in and ~3k out; progress is merged after every chunk, so a
 *  failure never loses more than one chunk of paid work. */
export const BACKFILL_CHUNK_NODES = 80;

/** Source id stamped on rows for a node with no provenance chat. */
const FALLBACK_SOURCE = "topic-backfill";

export interface BackfillResult {
	/** Untagged nodes found when the pass started. */
	pending: number;
	/** Nodes that received topics. */
	tagged: number;
	/** Topic rows appended. */
	rows: number;
	/** Set when the pass stopped early; rows merged so far stay. */
	error?: string;
}

export interface TopicBackfillDeps {
	graph: Pick<GraphStore, "readNodes" | "readTopics" | "readTopicAliases" | "writeTopicAliases">;
	tagOpen(
		nodes: readonly { id: string; name: string; statement: string }[],
		existing: readonly string[],
		signal?: AbortSignal,
	): Promise<{ nodeId: string; topics: string[] }[]>;
	canonicalize?(newTopics: readonly string[], existing: readonly string[], signal?: AbortSignal): Promise<Record<string, string>>;
	/** The pipeline's merger entry point for topic rows. */
	applyTopicRows(input: {
		sourceId: string;
		label: string;
		assignments: ReadonlyArray<{ nodeId: string; topics: readonly string[] }>;
	}): Promise<number>;
	/** Shows the run as a background activity row (the dock). Default: runs bare. */
	activityRow?<T>(title: string, run: (setTitle: (title: string) => void, signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface TopicBackfill {
	/** Count the untagged nodes; when there are any, start the pass in the
	 *  background. `completion` resolves with the result (never rejects). A call
	 *  while a pass is running joins it (`running: true`). */
	start(): { pending: number; running: boolean; completion?: Promise<BackfillResult> };
}

export function createTopicBackfill(deps: TopicBackfillDeps): TopicBackfill {
	let current: { pending: number; completion: Promise<BackfillResult> } | null = null;

	function untagged() {
		const tagged = new Set(deps.graph.readTopics().map((r) => r.nodeId));
		const seen = new Set<string>();
		const out: { id: string; name: string; statement: string; sourceId: string }[] = [];
		for (const n of deps.graph.readNodes()) {
			if (seen.has(n.id) || tagged.has(n.id)) continue;
			seen.add(n.id);
			out.push({ id: n.id, name: n.name, statement: n.statement, sourceId: n.provenance[0]?.chatId || FALLBACK_SOURCE });
		}
		return out;
	}

	async function run(nodes: ReturnType<typeof untagged>, setTitle: (t: string) => void, signal?: AbortSignal): Promise<BackfillResult> {
		const result: BackfillResult = { pending: nodes.length, tagged: 0, rows: 0 };
		try {
			for (let i = 0; i < nodes.length; i += BACKFILL_CHUNK_NODES) {
				signal?.throwIfAborted();
				setTitle(`Tagging topics · ${i}/${nodes.length}`);
				const chunk = nodes.slice(i, i + BACKFILL_CHUNK_NODES);
				const proposed = await deps.tagOpen(chunk, knownTopics(deps.graph.readTopics()), signal);
				const all = [...new Set(proposed.flatMap((a) => a.topics))];
				await canonicalizeAndStoreTopics(deps.graph, all, deps.canonicalize, [], signal);
				const aliases = deps.graph.readTopicAliases();
				const bySource = new Map<string, { nodeId: string; topics: string[] }[]>();
				const sourceOf = new Map(chunk.map((n) => [n.id, n.sourceId]));
				for (const a of proposed) {
					const topics = canonicalTopics(a.topics, aliases);
					if (topics.length === 0) continue;
					const source = sourceOf.get(a.nodeId) ?? FALLBACK_SOURCE;
					bySource.set(source, [...(bySource.get(source) ?? []), { nodeId: a.nodeId, topics }]);
					result.tagged += 1;
				}
				for (const [sourceId, assignments] of bySource) {
					result.rows += await deps.applyTopicRows({ sourceId, label: "Topic backfill", assignments });
				}
			}
		} catch (err) {
			result.error = err instanceof Error ? err.message : String(err);
			console.info(`[topic-backfill] stopped: ${result.error}`);
		}
		console.info(`[topic-backfill] tagged ${result.tagged}/${result.pending} nodes, ${result.rows} rows`);
		return result;
	}

	return {
		start() {
			if (current) return { pending: current.pending, running: true, completion: current.completion };
			const nodes = untagged();
			if (nodes.length === 0) return { pending: 0, running: false };
			const withRow = deps.activityRow ?? ((_title, fn) => fn(() => {}, new AbortController().signal));
			const completion = withRow(`Tagging topics · 0/${nodes.length}`, (setTitle, signal) => run(nodes, setTitle, signal)).finally(
				() => {
					current = null;
				},
			);
			current = { pending: nodes.length, completion };
			return { pending: nodes.length, running: false, completion };
		},
	};
}
