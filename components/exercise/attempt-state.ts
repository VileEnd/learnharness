/**
 * The attempt loop of an interactive exercise (teach and probe docks), as a
 * pure reducer: Check grades locally and keeps only the marks, a correct
 * Check (or Submit, or Show answer) closes the loop. Dock-local state; it
 * unmounts with the question, like the confidence index.
 */

import { stripExpected, type ExerciseVerdict, type InteractiveFormat } from "@/src/core";

export interface ExerciseAttemptState {
	/** The learner's current (format-shaped) response. */
	response: unknown;
	/** How many times Check was pressed. */
	attempts: number;
	/** How many pre-written hints were revealed. */
	hintsUsed: number;
	gaveUp: boolean;
	/** The last Check's marks (expected values stripped). */
	verdict?: ExerciseVerdict;
	/** The first Check, kept once retries follow. */
	firstAttempt?: { verdict: ExerciseVerdict; confidence?: number };
	/** The loop is closed: the dock submits the answer. */
	submitting: boolean;
}

export type ExerciseAttemptAction =
	| { type: "edit"; response: unknown }
	| { type: "check"; verdict: ExerciseVerdict; confidence?: number }
	| { type: "hint"; total: number }
	| { type: "giveUp" }
	| { type: "submit" };

export function initialAttemptState(response: unknown): ExerciseAttemptState {
	return { response, attempts: 0, hintsUsed: 0, gaveUp: false, submitting: false };
}

export function exerciseAttemptReducer(state: ExerciseAttemptState, action: ExerciseAttemptAction): ExerciseAttemptState {
	switch (action.type) {
		case "edit":
			return state.submitting ? state : { ...state, response: action.response };
		case "check": {
			if (state.submitting) return state;
			return {
				...state,
				attempts: state.attempts + 1,
				verdict: stripExpected(action.verdict),
				firstAttempt: state.firstAttempt ?? {
					verdict: action.verdict,
					...(action.confidence !== undefined ? { confidence: action.confidence } : {}),
				},
				submitting: action.verdict.outcome === "correct",
			};
		}
		case "hint":
			return state.hintsUsed >= action.total ? state : { ...state, hintsUsed: state.hintsUsed + 1 };
		case "giveUp":
			return { ...state, gaveUp: true, submitting: true };
		case "submit":
			return { ...state, submitting: true };
	}
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The untouched response for a format/spec. */
export function emptyResponse(format: InteractiveFormat, spec: unknown): unknown {
	switch (format) {
		case "numeric":
			return { value: "" };
		case "multipart": {
			const parts = isRec(spec) && Array.isArray(spec.parts) ? spec.parts : [];
			const out: Rec = {};
			for (const p of parts) {
				if (isRec(p) && typeof p.id === "string") out[p.id] = emptyResponse(p.format as InteractiveFormat, p.spec);
			}
			return { parts: out };
		}
		default:
			return { values: {} };
	}
}

/** The response that spells out a spec's answer key (the first accepted
 *  value of every item). For the answer-key view after `conclude`. */
export function keyResponse(format: InteractiveFormat, spec: unknown): unknown {
	if (!isRec(spec)) return emptyResponse(format, spec);
	switch (format) {
		case "numeric":
			return { value: typeof spec.answer === "string" ? spec.answer : "" };
		case "blanks": {
			const values: Rec = {};
			for (const b of Array.isArray(spec.blanks) ? spec.blanks : []) {
				if (isRec(b) && typeof b.id === "string" && Array.isArray(b.accept)) values[b.id] = String(b.accept[0] ?? "");
			}
			return { values };
		}
		case "table": {
			const values: Rec = {};
			for (const r of Array.isArray(spec.rows) ? spec.rows : []) {
				for (const c of isRec(r) && Array.isArray(r.cells) ? r.cells : []) {
					if (isRec(c) && typeof c.id === "string" && Array.isArray(c.accept)) values[c.id] = String(c.accept[0] ?? "");
				}
			}
			return { values };
		}
		case "multipart": {
			const parts: Rec = {};
			for (const p of Array.isArray(spec.parts) ? spec.parts : []) {
				if (isRec(p) && typeof p.id === "string") parts[p.id] = keyResponse(p.format as InteractiveFormat, p.spec);
			}
			return { parts };
		}
		default:
			return emptyResponse(format, spec);
	}
}

/** True when the response holds any non-blank text (Check needs something to grade). */
export function hasAnyText(response: unknown): boolean {
	if (typeof response === "string") return response.trim().length > 0;
	if (Array.isArray(response)) return response.some(hasAnyText);
	if (isRec(response)) return Object.values(response).some(hasAnyText);
	return false;
}
