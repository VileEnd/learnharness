/**
 * NOTE LAYOUT (0.29.0): where the teacher's notes go, so they never sit on each other, on a mark or on the
 * learner's typed objects. Pure and deterministic, in whatever coordinate space the caller works in (the
 * workspace's world space, the thumbnail's percent space).
 *
 * For each note in order: the sides round its mark in SIDES order (its preferred side first), each spot `gap`
 * clear of the mark; the first spot overlapping no obstacle and no note already placed wins. When every side
 * is taken, the spots are pushed outward in steps of `gap` (at most MAX_PUSH steps, nearest first); with none
 * free, the spot of least total overlap. A note not adjacent to its mark (pushed) gets a leader line. A fixed
 * side (the workspace keeps each note's side while the learner zooms) is the only side tried; the push still
 * applies.
 */

export type Box = { x: number; y: number; w: number; h: number };
export type Side = "below" | "above" | "right" | "left" | "below-right" | "below-left" | "above-right" | "above-left";

export interface NoteRequest {
	markBox: Box;
	w: number;
	h: number;
	prefer?: Side;
}

/** `leader` when the box is not adjacent to its markBox (pushed outward). */
export interface PlacedNote {
	box: Box;
	side: Side;
	leader: boolean;
}

export const SIDES: readonly Side[] = ["below", "above", "right", "left", "below-right", "below-left", "above-right", "above-left"];
const MAX_PUSH = 6;
/** Below this, two boxes only touch (float noise on shared edges is not an overlap). */
const EPS = 1e-6;

/** The outward direction of each side. */
const DIR: Record<Side, readonly [number, number]> = {
	below: [0, 1],
	above: [0, -1],
	right: [1, 0],
	left: [-1, 0],
	"below-right": [1, 1],
	"below-left": [-1, 1],
	"above-right": [1, -1],
	"above-left": [-1, -1],
};

/** The spot on `side`, pushed out `push` steps: below/above hang from the mark's left edge, right/left are
 *  centred on it, the diagonals sit off its corners. */
function spot({ markBox: m, w, h }: NoteRequest, side: Side, gap: number, push: number): Box {
	const [dx, dy] = DIR[side];
	const x = dx > 0 ? m.x + m.w + gap : dx < 0 ? m.x - gap - w : m.x;
	const y = dy > 0 ? m.y + m.h + gap : dy < 0 ? m.y - gap - h : m.y + (m.h - h) / 2;
	return { x: x + dx * push * gap, y: y + dy * push * gap, w, h };
}

function overlapArea(a: Box, b: Box): number {
	const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return ix > EPS && iy > EPS ? ix * iy : 0;
}

export function layoutNotes(notes: readonly NoteRequest[], obstacles: readonly Box[], gap: number, fixedSides?: readonly (Side | undefined)[]): PlacedNote[] {
	const placed: PlacedNote[] = [];
	notes.forEach((note, i) => {
		const fixed = fixedSides?.[i];
		const sides = fixed ? [fixed] : note.prefer ? [note.prefer, ...SIDES.filter((s) => s !== note.prefer)] : SIDES;
		const blockers = [...obstacles, ...placed.map((p) => p.box)];
		let best: { box: Box; side: Side; push: number; cost: number } | null = null;
		search: for (let push = 0; push <= MAX_PUSH; push++) {
			for (const side of sides) {
				const box = spot(note, side, gap, push);
				const cost = blockers.reduce((sum, b) => sum + overlapArea(box, b), 0);
				if (!best || cost < best.cost) best = { box, side, push, cost };
				if (cost === 0) break search;
			}
		}
		const { box, side, push } = best!;
		placed.push({ box, side, leader: push > 0 });
	});
	return placed;
}
