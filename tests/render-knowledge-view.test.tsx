/**
 * The "My knowledge" view (SSR, no DOM): the overview derivation (grouping,
 * ordering, counts, from hand-built input), the subset graph's edges, the
 * empty state on both tabs, the five bottom tabs in order and the sidebar entry.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BottomTabsBar } from "../components/bottom-tabs.tsx";
import { KnowledgeBody, KnowledgeTabSwitch, parseKnowledgeTab } from "../components/knowledge-view.tsx";
import { KNOWLEDGE_EMPTY_TEXT, KnowledgeOverviewBody } from "../components/knowledge-overview.tsx";
import { SidebarLibraryLinks } from "../components/sidebar.tsx";
import type { ConceptState, EvidenceEvent, GraphChain, GraphNode, KnowledgeView, TopicRow } from "../src/core/contracts.ts";
import { buildKnowledgeOverview, checkedConceptIds, knowledgeSubgraph } from "../src/core/knowledge.ts";

const ev = (conceptId: string, at = "2026-10-20T10:00:00.000Z"): EvidenceEvent => ({
	at,
	conceptId,
	chatId: "chat1",
	toolCallId: `q-${conceptId}-${at}`,
	kind: "quiz",
	raw: "correct",
	result: "clean",
});

const cs = (id: string, over: Partial<ConceptState> = {}, events = 0): ConceptState => ({
	conceptId: id,
	state: "not-yet-checked",
	due: false,
	streak: 0,
	weakFoundation: false,
	last: [],
	history: Array.from({ length: events }, (_, i) => ev(id, `2026-10-2${i}T10:00:00.000Z`)),
	openMisconceptions: [],
	...over,
});

const node = (id: string, name: string): GraphNode => ({ id, name, statement: `${name} statement`, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] });
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, provenance: [], createdAt: "2026-10-01T00:00:00.000Z" });
const row = (nodeId: string, topic: string): TopicRow => ({ nodeId, topic, sourceId: "s1", at: "2026-10-01T00:00:00.000Z" });

const NODES = [node("a", "Mutex"), node("b", "Semaphore"), node("c", "Deadlock"), node("d", "Monitor"), node("e", "BFS"), node("f", "DFS"), node("g", "Loose idea")];

// a: solid + due (3 events), b: learning (1), c: shaky + confusion (2), d: unchecked,
// e: solid (1), f: unchecked, g: learning, untagged (1).
const STATES: Record<string, ConceptState> = {
	a: cs("a", { state: "solid", due: true, streak: 2, nextReviewAt: "2026-10-18T00:00:00.000Z" }, 3),
	b: cs("b", { state: "learning", due: true, streak: 1, nextReviewAt: "2026-10-10T00:00:00.000Z" }, 1),
	c: cs("c", { state: "shaky", openMisconceptions: [{ term: "locks are free", instead: "locks cost", why: "contention", at: "2026-10-21T00:00:00.000Z" }] }, 2),
	d: cs("d"),
	e: cs("e", { state: "solid", streak: 2 }, 1),
	f: cs("f"),
	g: cs("g", { state: "learning", streak: 1 }, 1),
};

const TOPICS: TopicRow[] = [
	row("a", "Concurrency"),
	row("b", "Semaphores"), // aliased onto Concurrency below
	row("c", "concurrency"),
	row("d", "Concurrency"),
	row("e", "Graphs"),
	row("f", "Graphs"),
	row("b", "Graphs"), // b is in two topics
];
const ALIASES = { semaphores: "Concurrency" };

const overview = () => buildKnowledgeOverview({ states: STATES, nodes: NODES, topicRows: TOPICS, aliases: ALIASES });

describe("buildKnowledgeOverview", () => {
	it("counts checked concepts and lists due ones oldest first (learning/solid only)", () => {
		const o = overview();
		assert.equal(o.checkedCount, 5);
		assert.deepEqual(o.due.map((c) => c.id), ["b", "a"]);
	});

	it("lists open confusions with the concept name", () => {
		const o = overview();
		assert.equal(o.confusions.length, 1);
		assert.deepEqual(o.confusions[0], { conceptId: "c", conceptName: "Deadlock", term: "locks are free", instead: "locks cost", why: "contention", at: "2026-10-21T00:00:00.000Z" });
	});

	it("groups per canonical topic with checked/total, most evidence activity first, untagged last", () => {
		const o = overview();
		assert.deepEqual(o.topics.map((t) => t.label), ["Concurrency", "Graphs", null]);
		const [conc, graphs, untagged] = o.topics;
		// Concurrency = a, b (via the alias), c, d: 3 of 4 checked; activity 3 + 1 + 2.
		assert.equal(conc!.total, 4);
		assert.equal(conc!.checked, 3);
		assert.equal(conc!.activity, 6);
		assert.deepEqual(conc!.solid.map((c) => c.id), ["a"]);
		assert.deepEqual(conc!.learning.map((c) => c.id), ["b"]);
		assert.deepEqual(conc!.shaky.map((c) => c.id), ["c"]);
		assert.ok(conc!.solid[0]!.due);
		// Graphs = e, f, and b again (two topics): 2 of 3 checked.
		assert.equal(graphs!.total, 3);
		assert.equal(graphs!.checked, 2);
		assert.deepEqual(graphs!.solid.map((c) => c.id), ["e"]);
		assert.deepEqual(graphs!.learning.map((c) => c.id), ["b"]);
		// g has no topic.
		assert.equal(untagged!.total, 1);
		assert.equal(untagged!.checked, 1);
		assert.deepEqual(untagged!.learning.map((c) => c.id), ["g"]);
	});

	it("breaks activity ties by topic name and omits topics with nothing checked", () => {
		const states = { a: cs("a", { state: "learning" }, 1), b: cs("b", { state: "learning" }, 1), c: cs("c") };
		const o = buildKnowledgeOverview({
			states,
			nodes: [node("a", "A"), node("b", "B"), node("c", "C")],
			topicRows: [row("a", "Zeta"), row("b", "Alpha"), row("c", "Empty")],
			aliases: {},
		});
		assert.deepEqual(o.topics.map((t) => t.label), ["Alpha", "Zeta"]);
	});

	it("is empty when nothing has evidence", () => {
		const o = buildKnowledgeOverview({ states: { a: cs("a") }, nodes: [node("a", "A")], topicRows: [], aliases: {} });
		assert.equal(o.checkedCount, 0);
		assert.deepEqual(o.topics, []);
	});
});

describe("knowledgeSubgraph", () => {
	const chains = [
		chain("arg_1", ["a"], "b"), // both checked: one direct arrow
		chain("arg_2", ["a", "e"], "c"), // all checked: an implication node + 3 arrows
		chain("arg_3", ["b", "d"], "c"), // d is unchecked: dropped
		chain("arg_4", ["c"], "f"), // f is unchecked: dropped
	];

	it("keeps only edges whose ends are all checked", () => {
		const checked = checkedConceptIds(STATES, NODES);
		assert.deepEqual([...checked].sort(), ["a", "b", "c", "e", "g"]);
		const view = knowledgeSubgraph({ nodes: NODES, chains }, checked);
		const edges = view.edges.map((e) => `${e.from}>${e.to}`).sort();
		assert.deepEqual(edges, ["a>arg_2", "a>b", "arg_2>c", "e>arg_2"]);
		assert.deepEqual(view.nodes.map((n) => n.id).filter((id) => !id.startsWith("arg_")).sort(), ["a", "b", "c", "e", "g"]);
		assert.ok(!view.nodes.some((n) => n.id === "d" || n.id === "f" || n.id === "arg_3" || n.id === "arg_4"));
	});
});

const emptyView = (): KnowledgeView => ({
	learner: { asOf: "2026-10-25T00:00:00.000Z", states: {}, sessions: {} },
	overview: { checkedCount: 0, due: [], confusions: [], topics: [] },
	graph: { nodes: [], edges: [], logicalEdges: [], impLinks: [], sessions: {}, fileSources: {}, nodeSessions: {}, documents: {} },
});

describe("empty state", () => {
	it("both tabs show the same message", () => {
		for (const tab of ["graph", "overview"] as const) {
			const html = renderToStaticMarkup(<KnowledgeBody view={emptyView()} tab={tab} focusId={null} onFocusDone={() => {}} onOpenConcept={() => {}} />);
			assert.ok(html.includes('data-testid="knowledge-empty"'), tab);
			assert.ok(html.includes(KNOWLEDGE_EMPTY_TEXT), tab);
		}
		assert.equal(KNOWLEDGE_EMPTY_TEXT, "Nothing checked yet: answer questions in a session and your knowledge grows here.");
	});
});

describe("overview render", () => {
	it("shows due, confusions and the per-topic counts and state groups", () => {
		const html = renderToStaticMarkup(<KnowledgeOverviewBody overview={overview()} onOpenConcept={() => {}} />);
		assert.ok(html.includes("Due today"));
		assert.ok(html.includes("Open confusions"));
		assert.ok(html.includes("You thought: locks are free"));
		assert.ok(html.includes("Instead: locks cost"));
		assert.ok(html.includes("Why: contention"));
		assert.ok(html.includes("3 / 4 concepts checked"));
		assert.ok(html.includes("2 / 3 concepts checked"));
		assert.ok(html.includes("Untagged"));
		assert.ok(html.indexOf('data-testid="overview-group-solid"') < html.indexOf('data-testid="overview-group-learning"'));
		assert.ok(html.includes('data-due="true"'));
	});
});

describe("switch", () => {
	it("Graph | Overview, the active one selected; Graph is the default", () => {
		assert.equal(parseKnowledgeTab(null), "graph");
		assert.equal(parseKnowledgeTab("nonsense"), "graph");
		assert.equal(parseKnowledgeTab("overview"), "overview");
		const html = renderToStaticMarkup(<KnowledgeTabSwitch tab="graph" onTab={() => {}} />);
		assert.ok(html.indexOf("Graph") < html.indexOf("Overview"));
		assert.match(html, /data-testid="knowledge-tab-graph"[^>]*>/);
		assert.match(html, /aria-selected="true"[^>]*data-testid="knowledge-tab-graph"/);
	});
});

describe("navigation", () => {
	const noop = () => {};
	const bar = (pathname: string) =>
		renderToStaticMarkup(
			<BottomTabsBar pathname={pathname} drawerOpen={false} onGraph={noop} onKnowledge={noop} onSessions={noop} onNew={noop} onSettings={noop} />,
		);

	it("the phone tab bar has five tabs: Graph, Knowledge, Sessions, New, Settings", () => {
		const html = bar("/");
		const ids = [...html.matchAll(/data-testid="(tab-[a-z]+)"/g)].map((m) => m[1]);
		assert.deepEqual(ids, ["tab-graph", "tab-knowledge", "tab-sessions", "tab-new", "tab-settings"]);
	});

	it("the Knowledge tab is current on /knowledge only", () => {
		assert.match(bar("/knowledge"), /data-testid="tab-knowledge" aria-current="page"/);
		assert.doesNotMatch(bar("/"), /data-testid="tab-knowledge" aria-current="page"/);
	});

	it("the sidebar lists My knowledge right after Documents", () => {
		const html = renderToStaticMarkup(<SidebarLibraryLinks pathname="/documents" />);
		assert.ok(html.indexOf('data-testid="documents-entry"') < html.indexOf('data-testid="knowledge-entry"'));
		assert.ok(html.includes("My knowledge"));
		assert.ok(html.includes('href="/knowledge"'));
		assert.match(renderToStaticMarkup(<SidebarLibraryLinks pathname="/knowledge" />), /data-testid="knowledge-entry" aria-current="page"/);
	});
});
