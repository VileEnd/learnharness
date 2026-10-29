/**
 * NOTE LAYOUT (0.29.0): where the teacher's notes go. Pure and deterministic: each note takes the first free
 * spot around its mark (sides in order, its preferred side first), is pushed outward when every side is
 * blocked (then a leader joins it to its mark), and a fixed side (the workspace's stable spots) is kept.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { layoutNotes, type Box, type NoteRequest } from "../components/canvas/note-layout.ts";

const overlaps = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);

describe("layoutNotes", () => {
	// five marks crowded into one 40x40 area, each with a 60x20 note
	const crowded: NoteRequest[] = [0, 1, 2, 3, 4].map((i) => ({ markBox: { x: 100 + i * 7, y: 100 + ((i * 13) % 30), w: 10, h: 10 }, w: 60, h: 20 }));

	it("five notes on marks within one 40x40 area never overlap each other", () => {
		const placed = layoutNotes(crowded, [], 4);
		assert.equal(placed.length, 5);
		for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!overlaps(placed[i]!.box, placed[j]!.box), `${i} and ${j}`);
	});

	it("a note blocked on every side is pushed outward, clear of the obstacles, with a leader", () => {
		const walls: Box[] = [
			{ x: 80, y: 80, w: 60, h: 20 },
			{ x: 80, y: 120, w: 60, h: 20 },
			{ x: 80, y: 100, w: 20, h: 20 },
			{ x: 120, y: 100, w: 20, h: 20 },
		];
		const [note] = layoutNotes([{ markBox: { x: 100, y: 100, w: 20, h: 20 }, w: 30, h: 10 }], walls, 4);
		assert.equal(note!.leader, true);
		for (const wall of walls) assert.ok(!overlaps(note!.box, wall));
		const [free] = layoutNotes([{ markBox: { x: 100, y: 100, w: 20, h: 20 }, w: 30, h: 10 }], [], 4);
		assert.deepEqual(free, { box: { x: 100, y: 124, w: 30, h: 10 }, side: "below", leader: false });
	});

	it("is deterministic", () => {
		assert.deepEqual(layoutNotes(crowded, [{ x: 90, y: 140, w: 80, h: 10 }], 4), layoutNotes(crowded, [{ x: 90, y: 140, w: 80, h: 10 }], 4));
	});

	it("a fixed side is kept", () => {
		const [note] = layoutNotes([{ markBox: { x: 100, y: 100, w: 20, h: 20 }, w: 30, h: 10 }], [], 4, ["above"]);
		assert.equal(note!.side, "above");
		assert.ok(note!.box.y + note!.box.h <= 100);
	});
});
