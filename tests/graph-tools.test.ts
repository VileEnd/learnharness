// THE GRAPH TOOLS - the extraction auditor's (find_candidates / list_sessions / list_propositions).
// The prober's names-only map tools are retired: the library (concepts/ files)
// replaces them, and the prober registry must not carry them.


import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import { prepareAuditorReview } from "../src/agent/tools/graph.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId: string }>,
): GraphNode => ({
	id,
	name,
	statement: `statement of ${name}`, // must NEVER leak into tool output
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
	} = {},
): { chatStore: ChatStore; graphStore: GraphStore } {
	const chains: GraphChain[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
		readPositions: () => ({}),
		writePositions: () => {},
		readClusterLabels: () => [],
		appendClusterLabel: () => {},
		appendNamingRun: () => {},
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "c1",
	deliver: () => {},
	jobStore: stubJobStore,
	spawn: () => {},
	libraryRoot: "/nonexistent-library",
};

// ─── the prober carries no names-only map tools (retired; the library replaces them) ───

describe("prober tools", () => {
	it("prober has no names-only map tools", () => {
		const { chatStore } = fakeStores([]);
		const keys = Object.keys(createProberTools({ ...baseCtx, chatStore }));
		assert.equal(keys.includes("list_sessions"), false);
		assert.equal(keys.includes("list_propositions"), false);
	});
});

// ─── the auditor's toolset (2026-09-27 relink) ───────────────────────────────

describe("auditor graph tools", () => {
	const nodes = [
		{ ...node("n1", "Will to power", [pt("c1")]), statement: "The will to power is Nietzsche's central drive.", aliases: ["power drive"] },
		{ ...node("n2", "Eternal recurrence", [pt("c1")]), statement: "Eternal recurrence is the thought experiment of living again.", aliases: [] },
	];
	const { chatStore, graphStore } = fakeStores(nodes);

	it("find_candidates: first page preloaded, BM25 ranked; cursors are bound to their finding and fixed query", async () => {
		const many = Array.from({ length: 7 }, (_, i) => ({
			...node(`m${i}`, `Power ${i}`, [pt("c1")]),
			statement: `Power law number ${i}`,
		}));
		const { chatStore: cs, graphStore: gs } = fakeStores([...nodes, ...many]);
		const props = [
			{ id: "p1", name: "Will", statement: "The will to power is the central drive", aliases: [] },
			{ id: "p2", name: "Law", statement: "A power law", aliases: [] },
		];
		const { initialCandidates, tools } = prepareAuditorReview({ chatStore: cs, graphStore: gs }, props);
		assert.equal(initialCandidates.matches.length, 2);
		assert.equal(initialCandidates.matches[0]!.candidateIds[0], "n1");
		assert.ok(initialCandidates.matches.every((m) => m.candidateIds.length <= 5));
		const cursor = initialCandidates.matches[1]!.nextCursor;
		assert.ok(cursor, "p2 has more than one page");
		const run = async (input: unknown) => (await tools.find_candidates!.execute!("tc", input)).details as typeof initialCandidates;
		const next = await run({ propositions: [{ id: "p2", cursor }] });
		assert.ok(next.matches[0]!.candidateIds.length > 0);
		assert.ok(!next.matches[0]!.candidateIds.some((id) => initialCandidates.matches[1]!.candidateIds.includes(id)));
		await assert.rejects(run({ propositions: [{ id: "p1", cursor }] }), /Unknown cursor/);
		await assert.rejects(run({ propositions: [{ id: "p2", cursor, hints: ["x"] }] }), /fixes its query/);
		await assert.rejects(run({ propositions: [{ id: "nope" }] }), /Unknown proposition id/);
		// Hints are plain words that add vocabulary.
		const hinted = await run({ propositions: [{ id: "p2", hints: ["recurrence"] }] });
		assert.ok(hinted.matches[0]!.candidateIds.includes("n2"));
	});

	it("list_sessions: names, kinds, counts, ids — NO timestamps (identity work needs content, not chronology)", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes, {
			chats: [{ id: "c1", title: "Nietzsche seminar", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z" }],
		});
		const { tools } = prepareAuditorReview({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /1 session\(s\):/);
		assert.match(out, /Nietzsche seminar \(chat, 2 propositions\) — id: c1/);
		assert.ok(!out.includes("2026-09-20"), "no dates in the auditor's view");
	});

	it("list_propositions: FULL statement text (identity work), no dates", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes);
		const { tools } = prepareAuditorReview({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) born in this session:/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		assert.ok(!out.includes("2026-09"), "no dates in the auditor's view");
		const miss = (await tools.list_propositions!.execute!("tc", { session: "no-such" })).details as string;
		assert.equal(miss, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});
