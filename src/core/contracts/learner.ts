/**
 * Learner-model contracts (evidence layer): what the learner has SHOWN, per
 * concept, derived at read time from the chat records plus the attribution
 * ledger. Nothing here is a stored score. Part of the domain-split contracts
 * (src/core/contracts/). Pure types.
 */

import type { GraphSnapshot } from "./graph.ts";

/** How an evidence event counts: a clean success, a weak one (tentative,
 *  hinted, partly right) or a failure. */
export type EvidenceResult = "clean" | "weak" | "failed";

/** One thing the learner showed about one concept. */
export interface EvidenceEvent {
	/** ISO instant the evidence landed (the answer, the grade, the conclusion). */
	at: string;
	conceptId: string;
	chatId: string;
	/** The question/problem call this came from (a practice event carries the conclude call's id). */
	toolCallId: string;
	kind: "quiz" | "probe" | "explain" | "recall" | "exercise" | "assess" | "work" | "sketch" | "practice";
	/** correct | miss | dontKnow | partly | wrong | solved | solvedWithHints | movedOn | surrendered | tentative | correctWithHelp | miss */
	raw: string;
	result: EvidenceResult;
	/** His note on a quiz, the agent's note on a grade, the verdict on a practice problem. */
	note?: string;
	/** The mistaken idea this evidence exposed (OKF `not:` shape). */
	misconception?: { term: string; instead?: string; why?: string };
}

/** One attribution ledger row (data/learner/attributions.jsonl): which concepts a
 *  graded-but-untagged item belongs to. An explicit empty `conceptIds` is a
 *  result too (the item is off-map, never sent again). */
export interface AttributionRow {
	chatId: string;
	toolCallId: string;
	conceptIds: string[];
	at: string;
}

/** Where a concept stands, derived from its evidence (never stored). */
export type ConceptStateName = "not-yet-checked" | "shaky" | "learning" | "solid";

export interface ConceptState {
	conceptId: string;
	state: ConceptStateName;
	/** Learning or solid, and its review interval has passed. */
	due: boolean;
	/** Consecutive clean, spaced sessions since the last weak or failed one. */
	streak: number;
	/** ISO instant the next review is due; absent when the concept has no counted clean session. */
	nextReviewAt?: string;
	/** A premise (via a chain concluding this concept) is shaky or due. One level deep. */
	weakFoundation: boolean;
	/** The latest evidence, newest first, at most 3. */
	last: EvidenceEvent[];
	/** All evidence, oldest first. */
	history: EvidenceEvent[];
	/** The confusions not yet closed by a clean session, deduplicated by term. */
	openMisconceptions: Array<{ term: string; instead?: string; why?: string; at: string }>;
}

/** The learner model at one instant: a state per concept that exists. */
export interface LearnerSnapshot {
	asOf: string;
	states: Record<string, ConceptState>;
}

/** What GET /api/learner returns: the snapshot plus the titles of the sessions its evidence
 *  cites (chat id -> title), so the client can name them. A chat that is gone has no entry. */
export interface LearnerView extends LearnerSnapshot {
	sessions: Record<string, string>;
}

// ─── the "My knowledge" view (GET /api/knowledge) ────────────────────────────

/** One checked concept as the overview lists it. */
export interface KnowledgeConceptRef {
	id: string;
	name: string;
	state: Exclude<ConceptStateName, "not-yet-checked">;
	due: boolean;
	nextReviewAt?: string;
}

/** One topic of the overview: how much of it has been checked, and the
 *  checked concepts by state. A concept in several topics appears in each. */
export interface KnowledgeTopicGroup {
	/** The canonical topic label; null = concepts without any topic ("Untagged"). */
	label: string | null;
	/** Concepts with this topic (checked or not). */
	total: number;
	/** Of those, the ones with evidence (state is not "not-yet-checked"). */
	checked: number;
	/** Evidence events across the topic's concepts: the ordering key. */
	activity: number;
	solid: KnowledgeConceptRef[];
	learning: KnowledgeConceptRef[];
	shaky: KnowledgeConceptRef[];
}

export interface KnowledgeConfusion {
	conceptId: string;
	conceptName: string;
	term: string;
	instead?: string;
	why?: string;
	at: string;
}

/** The Overview tab, computed server-side (core/knowledge.ts). */
export interface KnowledgeOverview {
	/** Concepts with evidence: 0 = the empty state. */
	checkedCount: number;
	/** Learning/solid concepts that are due, oldest due first. */
	due: KnowledgeConceptRef[];
	/** Every open confusion of a checked concept, newest first. */
	confusions: KnowledgeConfusion[];
	/** Topics with at least one checked concept, most evidence activity first (ties by name; Untagged last among ties). */
	topics: KnowledgeTopicGroup[];
}

/** The Graph tab's data: the checked concepts only (+ derived implication nodes),
 *  edges from the chains among them, and the provenance the detail card cites. */
export type KnowledgeGraph = Pick<
	GraphSnapshot,
	"nodes" | "edges" | "logicalEdges" | "impLinks" | "sessions" | "fileSources" | "nodeSessions" | "documents"
>;

/** What GET /api/knowledge returns. */
export interface KnowledgeView {
	learner: LearnerView;
	overview: KnowledgeOverview;
	graph: KnowledgeGraph;
}
