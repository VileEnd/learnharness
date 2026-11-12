/**
 * The ONE mapping from a concept's learner state to a colour (browser-safe,
 * pure). The graph canvas and the legend both read it, so a state can never
 * be one colour on the canvas and another in the key.
 *
 * Themes (step 2, 2026-11-12): every colour is a CSS variable, set per theme
 * in app/globals.css (src/core/themes.ts tokens). The DOM (legend, chips,
 * the overview) uses `color` as is; the canvases resolve `cssVar` to hex
 * (components/css-color.ts tokenHex) and re-read it when the palette moves.
 *   Default (dark), unchanged: red-500 #ef4444, yellow-500 #eab308,
 *   green-500 #22c55e (the confidence rail's ramp), "not yet checked" the
 *   muted text #8d8d8d, the "due" ring the text colour #e6e6e6.
 *   Ivory (light): the theme's own error / warning / success inks, which
 *   read on the light page; "not yet checked" and the ring follow the text
 *   tokens, so the ring turns dark instead of vanishing.
 *
 * `due` is not a colour of its own: it is a RING drawn on top of the state
 * colour. weakFoundation is not drawn on the graph at all (detail card only).
 */

import type { ConceptStateName } from "./contracts/learner.ts";

export interface LearnerStateStyle {
	/** The fill, as a CSS value (`var(--lh-learner-…)`). */
	color: string;
	/** The variable behind it, for the canvas renderers. */
	cssVar: string;
	/** The legend word. */
	label: string;
}

const token = (cssVar: string) => ({ color: `var(${cssVar})`, cssVar });

export const LEARNER_STATE_STYLES: Readonly<Record<ConceptStateName, LearnerStateStyle>> = {
	shaky: { ...token("--lh-learner-shaky"), label: "Shaky" },
	learning: { ...token("--lh-learner-learning"), label: "Learning" },
	solid: { ...token("--lh-learner-solid"), label: "Solid" },
	"not-yet-checked": { ...token("--lh-learner-unchecked"), label: "Not yet checked" },
};

/** The ring that marks a concept as due for review (the text colour). */
export const LEARNER_DUE_RING = { ...token("--lh-learner-due"), label: "Due for review" } as const;

/** Legend order: the four states (the due ring follows). */
export const LEARNER_STATE_ORDER: readonly ConceptStateName[] = ["shaky", "learning", "solid", "not-yet-checked"];

/** How a raw evidence result reads in a sentence ("missed", "solved with hints"): shared by the me/ pages and the detail card. */
export const EVIDENCE_VERBS: Record<string, string> = {
	correct: "answered correctly",
	tentative: "answered correctly but unsure",
	miss: "missed",
	dontKnow: "didn't know",
	partly: "partly right",
	wrong: "got wrong",
	solved: "solved",
	solvedWithHints: "solved with hints",
	movedOn: "moved on",
	surrendered: "gave up",
};

/** What the canvas needs per node: its state colour and whether to ring it.
 *  `resolve` turns the state's CSS variable into a canvas colour (the
 *  caller's tokenHex); without it the colour is the CSS value. */
export function learnerNodeStyle(
	state: { state: ConceptStateName; due: boolean } | undefined,
	resolve?: (cssVar: string) => string,
): { color: string; due: boolean } {
	const style = LEARNER_STATE_STYLES[state?.state ?? "not-yet-checked"];
	return { color: resolve ? resolve(style.cssVar) : style.color, due: state?.due === true };
}

/** "Suggested: shaky and due": exactly the shaky concepts and the due ones,
 *  most urgent first - shaky before due, then due by oldest nextReviewAt
 *  (ties and missing dates by id, so the order is deterministic). Only ids in
 *  `knownIds` (when given) are returned: a concept that left the graph is not
 *  offered. */
export function suggestedConceptIds(
	states: Readonly<Record<string, { state: ConceptStateName; due: boolean; nextReviewAt?: string }>>,
	knownIds?: ReadonlySet<string>,
): string[] {
	const rows = Object.entries(states).filter(([id, s]) => (!knownIds || knownIds.has(id)) && (s.state === "shaky" || s.due));
	const rank = (s: { state: ConceptStateName }) => (s.state === "shaky" ? 0 : 1);
	return rows
		.sort(([ia, a], [ib, b]) => {
			if (rank(a) !== rank(b)) return rank(a) - rank(b);
			const na = a.nextReviewAt ?? "";
			const nb = b.nextReviewAt ?? "";
			if (na !== nb) return na < nb ? -1 : 1;
			return ia < ib ? -1 : ia > ib ? 1 : 0;
		})
		.map(([id]) => id);
}
