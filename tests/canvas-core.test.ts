/** Unit tests — canvas-core (pure, no server, no LLM). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cellOf, cellRect, drawingIdOf, nextObjectId, objectsAt, regionGrid, sceneBoundingBox, serializeSceneStructuredText, sha256Hex, validateDrawingScene,
	type DrawingScene,
} from "../src/core/canvas-core.ts";

const stroke = { id: "s1", z: 0, type: "stroke", brush: "pen", color: "ink", size: 3, points: [[10, 20, 0.5], [30, 40, 0.6]] };
const shape = { id: "s2", z: 1, type: "shape", shape: "rect", color: "red", strokeWidth: 2, x1: 0, y1: 0, x2: 50, y2: 60 };

test("drawingIdOf is stable across key order and ignores view", () => {
	const a = { version: 1, objects: [stroke] } as DrawingScene;
	const reordered = { objects: [{ points: stroke.points, size: 3, color: "ink", brush: "pen", type: "stroke", z: 0, id: "s1" }], view: { zoom: 2 }, version: 1 } as unknown as DrawingScene;
	assert.equal(drawingIdOf(a), drawingIdOf(reordered));
	assert.match(drawingIdOf(a), /^drw_[0-9a-f]{12}$/);
	assert.notEqual(drawingIdOf(a), drawingIdOf({ version: 1, objects: [] }));
});

test("validateDrawingScene rejects oversize and unknown types", () => {
	assert.equal(validateDrawingScene({ version: 1, objects: [stroke, shape] }).ok, true);
	assert.equal(validateDrawingScene({ version: 1, objects: [{ id: "o1", z: 0, type: "blob" }] }).ok, false);
	assert.equal(validateDrawingScene({ version: 2, objects: [] }).ok, false);
	const many = Array.from({ length: 20_001 }, (_, i) => ({ ...shape, id: `s${i}` }));
	assert.equal(validateDrawingScene({ version: 1, objects: many }).ok, false);
	const pts = Array.from({ length: 100_001 }, () => [0, 0, 1]);
	assert.equal(validateDrawingScene({ version: 1, objects: [{ ...stroke, points: pts }, { ...stroke, id: "s9", points: pts }] }).ok, false);
	assert.equal(validateDrawingScene({ version: 1, objects: [{ id: "o1", z: 0, type: "text", x: 0, y: 0, w: 1, h: 1, source: "x".repeat(20_001) }] }).ok, false);
});

test("sceneBoundingBox covers strokes, shapes and blocks with padding", () => {
	assert.equal(sceneBoundingBox({ version: 1, objects: [] }), null);
	const scene = validate({ version: 1, objects: [stroke, shape, { id: "o1", z: 2, type: "text", x: 100, y: 100, w: 20, h: 10, source: "hi" }] });
	assert.deepEqual(sceneBoundingBox(scene, 0), { x: 0, y: 0, w: 120, h: 110 });
	assert.deepEqual(sceneBoundingBox(scene), { x: -32, y: -32, w: 184, h: 174 });
});

test("regionGrid rows follow aspect", () => {
	assert.equal(regionGrid({ x: 0, y: 0, w: 1600, h: 800 }).rows, 4);
	assert.equal(regionGrid({ x: 0, y: 0, w: 800, h: 1600 }).rows, 16);
	assert.equal(regionGrid({ x: 0, y: 0, w: 100, h: 5000 }).rows, 16);
});

test("cellOf/cellRect round-trip", () => {
	const box = { x: 100, y: 50, w: 800, h: 400 };
	const grid = regionGrid(box);
	for (const cell of ["A1", "C4", "H4"]) {
		const r = cellRect(grid, box, cell);
		assert.ok(r);
		assert.equal(cellOf(grid, box, r.x + r.w / 2, r.y + r.h / 2), cell);
	}
	assert.equal(cellRect(grid, box, "Z99"), null);
	assert.equal(cellRect(grid, box, "A5"), null);
});

test("serializeSceneStructuredText tags typed objects with cells", () => {
	const box = { x: 0, y: 0, w: 800, h: 800 }; // 8x8 grid of 100px cells
	const scene = validate({ version: 1, objects: [
		stroke,
		{ id: "o1", z: 1, type: "latex", x: 250, y: 350, w: 50, h: 20, source: "\\int_0^1 x\\,dx" },
		{ id: "o2", z: 2, type: "table", x: 150, y: 550, w: 250, h: 150, cells: [["a", "b"], ["1", "2"]] },
	] });
	assert.equal(serializeSceneStructuredText(scene, box), "[o1 latex @C4] $\\int_0^1 x\\,dx$\n[o2 table @B6-D7]\n| a | b |\n| --- | --- |\n| 1 | 2 |\n[s1 ink stroke, line @A1]");
	assert.deepEqual(objectsAt(scene, box).C4, ["o1"]);
	assert.deepEqual(objectsAt(scene, box).C7, ["o2"]);
	assert.equal(nextObjectId(scene), "o3");
});

test("zero or negative size on a cell line keeps a forward span", () => {
	const box = { x: 0, y: 0, w: 800, h: 800 };
	const scene = validate({ version: 1, objects: [
		{ id: "o1", z: 0, type: "latex", x: 300, y: 300, w: 0, h: 0, source: "x" },
		{ id: "o2", z: 1, type: "latex", x: 300, y: 300, w: -50, h: -50, source: "y" },
	] });
	const text = serializeSceneStructuredText(scene, box);
	assert.match(text, /\[o1 latex @D4\]/);
	assert.match(text, /\[o2 latex @C3\]/);
	assert.deepEqual(objectsAt(scene, box).D4, ["o1"]);
	assert.deepEqual(objectsAt(scene, box).C3, ["o2"]);
});

test("sha256Hex matches a known vector", () => {
	assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	assert.equal(sha256Hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.equal(sha256Hex(new Uint8Array(1000).fill(97)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
});

function validate(raw: unknown): DrawingScene {
	const v = validateDrawingScene(raw);
	assert.ok(v.ok, v.ok ? "" : v.error);
	return v.scene;
}

// ---- stroke digest (M5) ----

const strokeOf = (id: string, color: string, pts: [number, number][]) => ({ id, z: 0, type: "stroke" as const, brush: "pen" as const, color, size: 3, points: pts.map(([x, y]) => [x, y, 0.5] as [number, number, number]) });
const digestOf = (objects: unknown[]) => {
	const scene = { version: 1, objects } as DrawingScene;
	return serializeSceneStructuredText(scene, { x: 0, y: 0, w: 800, h: 800 });
};
const line = (n: number, f: (t: number) => [number, number]) => Array.from({ length: n }, (_, i) => f(i / (n - 1)));

test("stroke digest: a vertical line, a horizontal line and a slanted line", () => {
	assert.equal(digestOf([strokeOf("s4", "blue", line(20, (t) => [350, 50 + 700 * t]))]), "[s4 blue stroke, vertical line @D1-D8]");
	assert.match(digestOf([strokeOf("s1", "ink", line(20, (t) => [50 + 700 * t, 400]))]), /^\[s1 ink stroke, horizontal line @A\d-H\d\]$/);
	assert.match(digestOf([strokeOf("s2", "ink", line(20, (t) => [50 + 700 * t, 50 + 700 * t]))]), /, line @/);
});

test("stroke digest: a parabola names the cell of its top (and a cup its bottom)", () => {
	// apex at (350, 100): cell D1 of an 8x8 grid of 100px cells
	const peak = line(41, (t) => [50 + 600 * t, 100 + 600 * (2 * t - 1) ** 2]);
	const [px, py] = peak.reduce((a, b) => (b[1] < a[1] ? b : a));
	assert.equal(`${Math.floor(px / 100)},${Math.floor(py / 100)}`, "3,1");
	assert.match(digestOf([strokeOf("s3", "red", peak)]), /^\[s3 red stroke, curve, top at D2 @/);
	const cup = line(41, (t) => [50 + 600 * t, 700 - 600 * (2 * t - 1) ** 2]);
	assert.match(digestOf([strokeOf("s3", "red", cup)]), /curve, bottom at D8 @/);
});

test("stroke digest: a closed loop, and freehand otherwise", () => {
	const loop = line(41, (t) => [400 + 200 * Math.cos(2 * Math.PI * t), 400 + 200 * Math.sin(2 * Math.PI * t)]);
	assert.match(digestOf([strokeOf("s5", "green", loop)]), /^\[s5 green stroke, closed loop @/);
	const zig = line(41, (t) => [50 + 700 * t, 400 + 200 * Math.sin(6 * Math.PI * t)]);
	assert.match(digestOf([strokeOf("s6", "ink", zig)]), /, freehand @/);
});

test("stroke digest: empty strokes are skipped, shapes are not strokes, typed objects come first", () => {
	const text = digestOf([
		strokeOf("s1", "ink", []),
		{ id: "s2", z: 1, type: "shape", shape: "rect", color: "red", strokeWidth: 2, x1: 0, y1: 0, x2: 50, y2: 60 },
		{ id: "o1", z: 2, type: "text", x: 0, y: 0, w: 10, h: 10, source: "hi" },
		strokeOf("s3", "ink", line(10, (t) => [100, 100 + 300 * t])),
	]);
	const rows = text.split("\n");
	assert.equal(rows.length, 2);
	assert.match(rows[0] as string, /^\[o1 text/);
	assert.match(rows[1] as string, /^\[s3 ink stroke, vertical line/);
	assert.equal(digestOf([strokeOf("s1", "ink", [])]), "");
});

test("stroke digest is capped at 40 lines with a +N more strokes summary", () => {
	const many = Array.from({ length: 45 }, (_, i) => strokeOf(`s${i + 1}`, "ink", line(5, (t) => [100 + i, 100 + 300 * t])));
	const rows = digestOf(many).split("\n");
	assert.equal(rows.length, 41);
	assert.equal(rows[40], "+5 more strokes");
	assert.match(rows[0] as string, /^\[s1 /);
});
