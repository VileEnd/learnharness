/**
 * An in-memory GraphStore (core/ports.ts) for suites that never touch
 * data/graph. Mirrors the real adapter's semantics where they matter:
 * an upsert keeps the usage log, rewriteLedgers replaces whole ledgers.
 */

import type {
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	SessionCheckpoint,
	TopicRow,
} from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";

export function memoryGraphStore(): GraphStore {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const topics: TopicRow[] = [];
	let aliases: Record<string, string> = {};
	const sources = new Map<string, NotesSource>();
	let positions: Record<string, { x: number; y: number }> = {};
	return {
		appendNode: (n) => void nodes.push({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] }),
		readNodes: () => nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })),
		appendChain: (c) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: (c) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		appendTopic: (r) => void topics.push({ ...r }),
		readTopics: () => topics.map((r) => ({ ...r })),
		readTopicAliases: () => ({ ...aliases }),
		writeTopicAliases: (a) => void (aliases = { ...a }),
		upsertSource: (s) => {
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		appendSourceUsage: (id: string, entry: ExtractionRunUsage) => {
			const source = sources.get(id);
			if (source && !source.extractions?.some((r) => r.startedAt === entry.startedAt)) {
				source.extractions = [...(source.extractions ?? []), entry];
			}
		},
		readPositions: () => ({ ...positions }),
		writePositions: (next) => void (positions = { ...next }),
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes);
			if (next.chains) chains.splice(0, chains.length, ...next.chains);
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage);
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints);
			if (next.topics) topics.splice(0, topics.length, ...next.topics);
		},
	};
}

/** A chat store with no chats: enough for graph derivations over sources. */
export const noChats = {
	listChats: () => [],
	getChat: () => null,
} as unknown as ChatStore;
