/**
 * The grade heal: fields the learner never sees must not strand a weaker model.
 * A `note` over the limit is cut at a word boundary with an ellipsis (inside the limit),
 * and a `misconception` sent with grade correct or dontKnow is dropped. Pure; runs at the
 * tool boundary (prepareArguments) AND on every read of the recorded call (heal parity).
 * Well-formed args pass through untouched (same reference); idempotent.
 */

export const GRADE_NOTE_MAX = 140;

/** Cut `s` to at most `max` characters at a word boundary, ending in "…". */
export function truncateAtWord(s: string, max: number): string {
	if (s.length <= max) return s;
	const room = s.slice(0, max - 1);
	const space = room.search(/\s\S*$/);
	const cut = space > 0 ? room.slice(0, space) : room;
	return `${cut.replace(/[\s,;:.\-]+$/, "")}…`;
}

export function healGradeArguments(args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const a = args as Record<string, unknown>;
	let out = a;
	if (typeof a.note === "string" && a.note.length > GRADE_NOTE_MAX) out = { ...out, note: truncateAtWord(a.note, GRADE_NOTE_MAX) };
	if (a.misconception !== undefined && a.grade !== "partly" && a.grade !== "wrong") {
		const { misconception: _dropped, ...rest } = out;
		out = rest;
	}
	return out;
}
