/**
 * The learner overlay's surfaces (SSR, no DOM): the detail card's knowledge
 * block, the legend, and the practice picker's "Suggested: shaky and due"
 * group; plus the pure colour mapping and the shared snapshot builder.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainTableBody } from "../components/chain-table.tsx";
import type { ChainSort } from "../components/chain-table.tsx";
import { LearnerLegend } from "../components/learner-legend.tsx";
import { NodeKnowledge } from "../components/node-knowledge.tsx";
import type { ConceptState, EvidenceEvent, GraphNode, LearnerSnapshot } from "../src/core/contracts.ts";
import { LEARNER_STATE_STYLES, learnerNodeStyle, suggestedConceptIds } from "../src/core/learner-colors.ts";
import { buildLearnerSnapshot } from "../src/server/learner-snapshot.ts";
import { chat, quiz } from "./learner-helpers.ts";

const ev = (over: Partial<EvidenceEvent>): EvidenceEvent => ({
	at: "2026-10-20T10:00:00.000Z",
	conceptId: "n1",
	chatId: "chat1",
	toolCallId: "q1",
	kind: "quiz",
	raw: "miss",
	result: "failed",
	...over,
});

const cs = (id: string, over: Partial<ConceptState> = {}): ConceptState => ({
	conceptId: id,
	state: "not-yet-checked",
	due: false,
	streak: 0,
	weakFoundation: false,
	last: [],
	history: [],
	openMisconceptions: [],
	...over,
});

describe("learner colours", () => {
	it("one colour per state, distinct, and the unknown concept reads as not yet checked", () => {
		const colors = Object.values(LEARNER_STATE_STYLES).map((s) => s.color);
		assert.equal(new Set(colors).size, 4);
		assert.deepEqual(learnerNodeStyle(undefined), { color: LEARNER_STATE_STYLES["not-yet-checked"].color, due: false });
		assert.deepEqual(learnerNodeStyle({ state: "solid", due: true }), { color: LEARNER_STATE_STYLES.solid.color, due: true });
	});

	it("suggests exactly the shaky and due concepts: shaky first, then due by oldest review date", () => {
		const ids = suggestedConceptIds({
			solidFresh: { state: "solid", due: false, nextReviewAt: "2026-12-01T00:00:00Z" },
			dueLate: { state: "learning", due: true, nextReviewAt: "2026-10-22T00:00:00Z" },
			shakyB: { state: "shaky", due: false },
			dueEarly: { state: "solid", due: true, nextReviewAt: "2026-10-10T00:00:00Z" },
			shakyA: { state: "shaky", due: false },
			unchecked: { state: "not-yet-checked", due: false },
		});
		assert.deepEqual(ids, ["shakyA", "shakyB", "dueEarly", "dueLate"]);
	});
});

describe("NodeKnowledge (the detail card block)", () => {
	it("a shaky concept shows its last evidence note with the session title and the next-review line", () => {
		const state = cs("n1", {
			state: "shaky",
			due: false,
			nextReviewAt: "2026-10-23T10:00:00.000Z",
			last: [ev({ note: "confused P and V" })],
			openMisconceptions: [{ term: "P increments", instead: "P decrements", at: "2026-10-20T10:00:00.000Z" }],
		});
		const html = renderToStaticMarkup(<NodeKnowledge state={state} sessions={{ chat1: "Semaphores" }} />);
		assert.ok(html.includes("Shaky"));
		assert.ok(html.includes("missed 2026-10-20 in &quot;Semaphores&quot;: confused P and V"));
		assert.ok(html.includes("Next review 2026-10-23"));
		assert.ok(html.includes("P increments → P decrements"));
	});

	it("shows at most 3 evidence lines, newest first, and no next-review line when there is none", () => {
		const last = ["04", "03", "02", "01"].map((d) => ev({ toolCallId: `q${d}`, at: `2026-10-${d}T10:00:00.000Z`, note: `note ${d}` }));
		const html = renderToStaticMarkup(<NodeKnowledge state={cs("n1", { state: "shaky", last })} sessions={{}} />);
		assert.equal(html.split('data-testid="node-knowledge-evidence"').length - 1, 3);
		assert.ok(html.indexOf("note 04") < html.indexOf("note 03"));
		assert.ok(!html.includes("note 01"));
		assert.ok(html.includes("in a session"));
		assert.ok(!html.includes("Next review"));
	});

	it("marks due and weak foundation; renders nothing without a state", () => {
		const html = renderToStaticMarkup(
			<NodeKnowledge state={cs("n1", { state: "solid", due: true, streak: 2, weakFoundation: true })} sessions={{}} />,
		);
		assert.ok(html.includes("Solid - 2 clean sessions in a row · due for review"));
		assert.ok(html.includes("A premise is shaky or due."));
		assert.equal(renderToStaticMarkup(<NodeKnowledge state={undefined} sessions={{}} />), "");
	});
});

describe("LearnerLegend", () => {
	it("lists the four states in their canvas colours plus the due ring; never takes pointer events", () => {
		const html = renderToStaticMarkup(<LearnerLegend />);
		for (const s of Object.values(LEARNER_STATE_STYLES)) {
			assert.ok(html.includes(s.label), s.label);
			assert.ok(html.toLowerCase().includes(s.color), s.color);
		}
		assert.ok(html.includes("Due for review"));
		assert.ok(html.includes("pointer-events-none"));
	});
});

describe("the practice picker's Suggested group", () => {
	const node = (id: string, name: string): GraphNode =>
		({ id, name, statement: `Statement ${name}.`, aliases: [], createdAt: "2026-09-20T10:00:00.000Z", provenance: [{ chatId: "chat1", messageId: `m_${id}` }] }) as unknown as GraphNode;
	const nodes = [node("a", "Alpha"), node("b", "Beta"), node("c", "Gamma"), node("d", "Delta"), node("e", "Epsilon")];
	const learner: LearnerSnapshot = {
		asOf: "2026-10-25T00:00:00.000Z",
		states: {
			a: cs("a", { state: "shaky" }),
			b: cs("b", { state: "solid", due: true, nextReviewAt: "2026-10-01T00:00:00.000Z" }),
			c: cs("c", { state: "solid" }),
			d: cs("d", { state: "learning" }),
			e: cs("e", { state: "not-yet-checked" }),
		},
	};
	const base = {
		nodes,
		chains: [],
		sessions: { chat1: "Lesson" },
		fileSources: {},
		query: "",
		onQuery: () => {},
		sort: { col: "name", dir: 1 } as ChainSort,
		onSort: () => {},
		selection: new Set<string>(),
		expandedClusters: new Set<string>(),
		expandedChains: new Set<string>(),
		onToggleCluster: () => {},
		onToggleChain: () => {},
		onToggleNodes: () => {},
		onClear: () => {},
		onDelete: () => {},
		onClose: () => {},
	};

	it("lists exactly the shaky and due concepts, shaky first", () => {
		const html = renderToStaticMarkup(<ChainTableBody {...base} selectMode learner={learner} />);
		assert.ok(html.includes("Suggested: shaky and due"));
		const rows = [...html.matchAll(/data-testid="suggested-row-(\w+)"/g)].map((m) => m[1]);
		assert.deepEqual(rows, ["a", "b"]);
	});

	it("is absent outside the practice picker and without learner data", () => {
		assert.ok(!renderToStaticMarkup(<ChainTableBody {...base} learner={learner} />).includes("Suggested: shaky"));
		assert.ok(!renderToStaticMarkup(<ChainTableBody {...base} selectMode />).includes("Suggested: shaky"));
	});
});

describe("buildLearnerSnapshot (the shared seam)", () => {
	it("derives a state per node from chats + attributions", () => {
		const record = chat("c1", [...quiz("q1", { pick: 2, concepts: ["n1"], at: "2026-10-20T10:00:00.000Z" })]);
		const snap = buildLearnerSnapshot(
			{
				chatStore: { listChats: () => [{ id: "c1" }] as never, getChat: () => record },
				learnerStore: { readAttributions: () => [] },
			},
			{ nodes: [{ id: "n1" }, { id: "n2" }] as never, chains: [] },
			new Date("2026-10-25T00:00:00.000Z"),
		);
		assert.deepEqual(Object.keys(snap.states).sort(), ["n1", "n2"]);
		assert.equal(snap.states.n2!.state, "not-yet-checked");
		assert.equal(snap.states.n1!.history.length, 1);
	});
});
