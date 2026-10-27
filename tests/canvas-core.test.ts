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
	assert.equal(serializeSceneStructuredText(scene, box), "[o1 latex @C4] $\\int_0^1 x\\,dx$\n[o2 table @B6-D7]\n| a | b |\n| --- | --- |\n| 1 | 2 |");
	assert.deepEqual(objectsAt(scene, box).C4, ["o1"]);
	assert.deepEqual(objectsAt(scene, box).C7, ["o2"]);
	assert.equal(nextObjectId(scene), "o3");
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
