// THE GRAPH TOOLS - the extraction auditor's (find / list_sessions / list_propositions).
// The prober's names-only map tools are retired: the library (concepts/ files)
// replaces them, and the prober registry must not carry them.


import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import { auditorGraphTools } from "../src/agent/tools/graph.ts";
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

	it("find: glob over names + statements + aliases, returning id + name + statement + BIRTH SESSION (owner, 2026-09-29)", async () => {
		const tools = auditorGraphTools({ chatStore, graphStore });
		const out = (await tools.find!.execute!("tc", { query: "*will to power*" })).details as string;
		assert.match(out, /1 match\(es\):/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		// The born-in pointer: hits compose with list_propositions.
		assert.match(out, /born in: c1/);
		// Statements and aliases hit too — and a bare term gets implicit stars.
		const byStatement = (await tools.find!.execute!("tc", { query: "living again" })).details as string;
		assert.match(byStatement, /n2 :: Eternal recurrence/);
		const byAlias = (await tools.find!.execute!("tc", { query: "power drive" })).details as string;
		assert.match(byAlias, /n1/);
		const miss = (await tools.find!.execute!("tc", { query: "*nothing matches this*" })).details as string;
		assert.equal(miss, 'No existing proposition matches "*nothing matches this*".');
	});

	it("list_sessions: names, kinds, counts, ids — NO timestamps (identity work needs content, not chronology)", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes, {
			chats: [{ id: "c1", title: "Nietzsche seminar", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z" }],
		});
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /1 session\(s\):/);
		assert.match(out, /Nietzsche seminar \(chat, 2 propositions\) — id: c1/);
		assert.ok(!out.includes("2026-09-20"), "no dates in the auditor's view");
	});

	it("list_propositions: FULL statement text (identity work), no dates", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes);
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) born in this session:/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		assert.ok(!out.includes("2026-09"), "no dates in the auditor's view");
		const miss = (await tools.list_propositions!.execute!("tc", { session: "no-such" })).details as string;
		assert.equal(miss, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});
