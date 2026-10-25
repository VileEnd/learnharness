/**
 * Learner-model contracts (evidence layer): what the learner has SHOWN, per
 * concept, derived at read time from the chat records plus the attribution
 * ledger. Nothing here is a stored score. Part of the domain-split contracts
 * (src/core/contracts/). Pure types.
 */

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
	kind: "quiz" | "probe" | "explain" | "recall" | "practice";
	/** correct | miss | dontKnow | partly | wrong | solved | solvedWithHints | movedOn | surrendered | tentative */
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
