/**
 * The ONE mapping from a concept's learner state to a colour (browser-safe,
 * pure). The graph canvas and the legend both read it, so a state can never
 * be one colour on the canvas and another in the key.
 *
 * Palette: the app's existing semantic hexes, the same ones the answered-card
 * and the confidence rail already use (components/confidence-rail.tsx ramp:
 * red-500 #ef4444, yellow-500 #eab308, green-500 #22c55e) plus the graph's own
 * neutral token (--ring / --muted-foreground, #8d8d8d). The app has a single
 * dark theme (app/globals.css: :root and .dark carry the same values), so
 * there is one value per slot; the canvas wants hex, not a CSS variable.
 *
 * `due` is not a colour of its own: it is a RING drawn on top of the state
 * colour (ring colour = --foreground, #e6e6e6). weakFoundation is not drawn
 * on the graph at all (detail card only).
 */

import type { ConceptStateName } from "./contracts/learner.ts";

export interface LearnerStateStyle {
	/** The node fill. */
	color: string;
	/** The legend word. */
	label: string;
	/** The existing token / palette entry the hex comes from. */
	token: string;
}

export const LEARNER_STATE_STYLES: Readonly<Record<ConceptStateName, LearnerStateStyle>> = {
	shaky: { color: "#ef4444", label: "Shaky", token: "red-500 (confidence ramp 0)" },
	learning: { color: "#eab308", label: "Learning", token: "yellow-500 (confidence ramp 50)" },
	solid: { color: "#22c55e", label: "Solid", token: "green-500 (confidence ramp 90)" },
	"not-yet-checked": { color: "#8d8d8d", label: "Not yet checked", token: "--ring / --muted-foreground" },
};

/** The ring that marks a concept as due for review (--foreground). */
export const LEARNER_DUE_RING = { color: "#e6e6e6", label: "Due for review", token: "--foreground" } as const;

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

/** What the canvas needs per node: its state colour and whether to ring it. */
export function learnerNodeStyle(
	state: { state: ConceptStateName; due: boolean } | undefined,
): { color: string; due: boolean } {
	const s = state?.state ?? "not-yet-checked";
	return { color: LEARNER_STATE_STYLES[s].color, due: state?.due === true };
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
