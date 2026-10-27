/**
 * canvas-core.ts (canvas workspace, PR 2): the drawing scene contract — types, validation, content
 * ids, bounding box, the labelled region grid and the structured-text view of typed objects.
 * Pure and browser-safe (no node:*): hashing is a pure-JS SHA-256. The view (pan/zoom) is
 * client-only and never part of a scene, so it is never hashed.
 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { healEncodedArguments } from "./argument-heal.ts";

export type Brush = "pen" | "pencil" | "marker";
export type ShapeKind = "line" | "arrow" | "rect" | "ellipse";

export type StrokeObject = { id: string; z: number; type: "stroke"; brush: Brush; color: string; size: number; points: [number, number, number][] };
export type ShapeObject = { id: string; z: number; type: "shape"; shape: ShapeKind; color: string; strokeWidth: number; x1: number; y1: number; x2: number; y2: number };
export type BlockObject = { id: string; z: number; type: "text" | "markdown" | "latex"; x: number; y: number; w: number; h: number; source: string };
export type TableObject = { id: string; z: number; type: "table"; x: number; y: number; w: number; h: number; cells: string[][] };
export type ImageObject = { id: string; z: number; type: "image"; x: number; y: number; w: number; h: number; assetId: string };
export type TypedObject = BlockObject | TableObject | ImageObject;
export type DrawingObject = StrokeObject | ShapeObject | TypedObject;
export type DrawingScene = { version: 1; objects: DrawingObject[] };
export type Box = { x: number; y: number; w: number; h: number };

export const MAX_OBJECTS = 20_000;
export const MAX_POINTS = 200_000;
export const MAX_SOURCE_CHARS = 20_000;
export const GRID_COLS = 8;
export const GRID_MAX_ROWS = 16;

const BRUSHES: readonly string[] = ["pen", "pencil", "marker"];
const SHAPES: readonly string[] = ["line", "arrow", "rect", "ellipse"];
const BLOCKS: readonly string[] = ["text", "markdown", "latex"];

export function isTypedObject(o: DrawingObject): o is TypedObject {
	return o.type !== "stroke" && o.type !== "shape";
}

// ---- validation ----

type Result = { ok: true; scene: DrawingScene } | { ok: false; error: string };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validates and normalizes (unknown keys such as a client `view` are dropped). */
export function validateDrawingScene(raw: unknown): Result {
	if (!isRec(raw)) return { ok: false, error: "scene must be an object" };
	if (raw.version !== 1) return { ok: false, error: "unsupported scene version" };
	if (!Array.isArray(raw.objects)) return { ok: false, error: "objects must be an array" };
	if (raw.objects.length > MAX_OBJECTS) return { ok: false, error: `too many objects (max ${MAX_OBJECTS})` };
	const objects: DrawingObject[] = [];
	const ids = new Set<string>();
	let points = 0;
	for (let i = 0; i < raw.objects.length; i++) {
		const o = raw.objects[i];
		const at = `objects[${i}]`;
		if (!isRec(o)) return { ok: false, error: `${at} must be an object` };
		if (typeof o.id !== "string" || !o.id) return { ok: false, error: `${at}.id must be a non-empty string` };
		if (ids.has(o.id)) return { ok: false, error: `${at}.id "${o.id}" is duplicated` };
		ids.add(o.id);
		if (!num(o.z)) return { ok: false, error: `${at}.z must be a finite number` };
		const base = { id: o.id, z: o.z };
		const t = o.type;
		if (t === "stroke") {
			if (typeof o.brush !== "string" || !BRUSHES.includes(o.brush)) return { ok: false, error: `${at}.brush is not a known brush` };
			if (typeof o.color !== "string" || !num(o.size)) return { ok: false, error: `${at} needs color and size` };
			if (!Array.isArray(o.points)) return { ok: false, error: `${at}.points must be an array` };
			points += o.points.length;
			if (points > MAX_POINTS) return { ok: false, error: `too many points (max ${MAX_POINTS})` };
			const pts: [number, number, number][] = [];
			for (const p of o.points) {
				if (!Array.isArray(p) || p.length !== 3 || !p.every(num)) return { ok: false, error: `${at}.points must be [x, y, pressure] numbers` };
				pts.push([p[0] as number, p[1] as number, p[2] as number]);
			}
			objects.push({ ...base, type: "stroke", brush: o.brush as Brush, color: o.color, size: o.size, points: pts });
		} else if (t === "shape") {
			if (typeof o.shape !== "string" || !SHAPES.includes(o.shape)) return { ok: false, error: `${at}.shape is not a known shape` };
			if (typeof o.color !== "string" || !num(o.strokeWidth) || !num(o.x1) || !num(o.y1) || !num(o.x2) || !num(o.y2)) return { ok: false, error: `${at} needs color, strokeWidth and x1,y1,x2,y2` };
			objects.push({ ...base, type: "shape", shape: o.shape as ShapeKind, color: o.color, strokeWidth: o.strokeWidth, x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 });
		} else if (typeof t === "string" && (BLOCKS.includes(t) || t === "table" || t === "image")) {
			if (!num(o.x) || !num(o.y) || !num(o.w) || !num(o.h)) return { ok: false, error: `${at} needs numeric x, y, w, h` };
			const geo = { x: o.x, y: o.y, w: o.w, h: o.h };
			if (t === "table") {
				if (!Array.isArray(o.cells) || !o.cells.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string" && c.length <= MAX_SOURCE_CHARS))) return { ok: false, error: `${at}.cells must be a string matrix` };
				objects.push({ ...base, type: "table", ...geo, cells: (o.cells as string[][]).map((r) => [...r]) });
			} else if (t === "image") {
				if (typeof o.assetId !== "string" || !o.assetId) return { ok: false, error: `${at}.assetId must be a string` };
				objects.push({ ...base, type: "image", ...geo, assetId: o.assetId });
			} else {
				if (typeof o.source !== "string") return { ok: false, error: `${at}.source must be a string` };
				if (o.source.length > MAX_SOURCE_CHARS) return { ok: false, error: `${at}.source exceeds ${MAX_SOURCE_CHARS} characters` };
				objects.push({ ...base, type: t as BlockObject["type"], ...geo, source: o.source });
			}
		} else return { ok: false, error: `${at}.type "${String(t)}" is not a known object type` };
	}
	return { ok: true, scene: { version: 1, objects } };
}

// ---- ids ----

/** Next typed-object id `o<n>` (strokes and shapes use `s<n>`, see nextStrokeId). */
export function nextObjectId(scene: DrawingScene): string {
	return `o${maxSuffix(scene, "o") + 1}`;
}
export function nextStrokeId(scene: DrawingScene): string {
	return `s${maxSuffix(scene, "s") + 1}`;
}
function maxSuffix(scene: DrawingScene, prefix: string): number {
	let max = 0;
	for (const o of scene.objects) {
		const m = new RegExp(`^${prefix}(\\d+)$`).exec(o.id);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return max;
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
	const rec = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const k of Object.keys(rec).sort()) {
		if (rec[k] === undefined) continue;
		parts.push(`${JSON.stringify(k)}:${canonicalJson(rec[k])}`);
	}
	return `{${parts.join(",")}}`;
}

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure-JS SHA-256, lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const padded = Math.ceil((bytes.length + 9) / 64) * 64;
	const buf = new Uint8Array(padded);
	buf.set(bytes);
	buf[bytes.length] = 0x80;
	const view = new DataView(buf.buffer);
	view.setUint32(padded - 8, Math.floor((bytes.length * 8) / 0x100000000));
	view.setUint32(padded - 4, (bytes.length * 8) >>> 0);
	const w = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let off = 0; off < padded; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15] as number;
			const b = w[i - 2] as number;
			const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
			const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
			w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
		}
		let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [number, number, number, number, number, number, number, number];
		for (let i = 0; i < 64; i++) {
			const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) | 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		const add = [a, b, c, d, e, f, g, hh];
		for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (add[i] as number)) | 0;
	}
	return Array.from(h, (x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/** `drw_` + first 12 hex of the hash of the canonical scene. Only version + objects count (never the view). */
export function drawingIdOf(scene: DrawingScene): string {
	const json = canonicalJson({ version: scene.version, objects: scene.objects });
	return `drw_${sha256Hex(new TextEncoder().encode(json)).slice(0, 12)}`;
}

// ---- geometry and the region grid ----

export function sceneBoundingBox(scene: DrawingScene, padding = 32): Box | null {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	const take = (x: number, y: number) => {
		if (x < x0) x0 = x;
		if (y < y0) y0 = y;
		if (x > x1) x1 = x;
		if (y > y1) y1 = y;
	};
	for (const o of scene.objects) {
		if (o.type === "stroke") for (const p of o.points) take(p[0], p[1]);
		else if (o.type === "shape") { take(o.x1, o.y1); take(o.x2, o.y2); }
		else { take(o.x, o.y); take(o.x + o.w, o.y + o.h); }
	}
	if (!Number.isFinite(x0)) return null;
	return { x: x0 - padding, y: y0 - padding, w: x1 - x0 + 2 * padding, h: y1 - y0 + 2 * padding };
}

export type RegionGrid = { cols: 8; rows: number; cellW: number; cellH: number };

/** 8 columns; rows follow the aspect (square cells), at least 1, at most 16. */
export function regionGrid(box: Box): RegionGrid {
	const w = Math.max(box.w, 1);
	const h = Math.max(box.h, 1);
	const rows = Math.min(GRID_MAX_ROWS, Math.max(1, Math.round((GRID_COLS * h) / w)));
	return { cols: GRID_COLS, rows, cellW: w / GRID_COLS, cellH: h / rows };
}

const COL_LETTERS = "ABCDEFGH";

/** Cell label such as "C4" (column letter, 1-based row); points outside the box clamp to the edge cell. */
export function cellOf(grid: RegionGrid, box: Box, x: number, y: number): string {
	const c = Math.min(grid.cols - 1, Math.max(0, Math.floor((x - box.x) / grid.cellW)));
	const r = Math.min(grid.rows - 1, Math.max(0, Math.floor((y - box.y) / grid.cellH)));
	return `${COL_LETTERS[c]}${r + 1}`;
}

/** The rectangle of a cell label, or null if it is not a cell of this grid. */
export function cellRect(grid: RegionGrid, box: Box, cell: string): Box | null {
	const m = /^([A-H])(\d{1,2})$/.exec(cell.trim().toUpperCase());
	if (!m) return null;
	const c = COL_LETTERS.indexOf(m[1] as string);
	const r = Number(m[2]) - 1;
	if (c < 0 || r < 0 || r >= grid.rows) return null;
	return { x: box.x + c * grid.cellW, y: box.y + r * grid.cellH, w: grid.cellW, h: grid.cellH };
}

/** The cell span of a typed object: "C4", or "B6-D7" (top-left to bottom-right) when it covers several. */
function spanOf(o: TypedObject, grid: RegionGrid, box: Box): string {
	// Normalize so a zero or negative w/h still yields end >= start.
	const x0 = Math.min(o.x, o.x + o.w);
	const x1 = Math.max(o.x, o.x + o.w);
	const y0 = Math.min(o.y, o.y + o.h);
	const y1 = Math.max(o.y, o.y + o.h);
	const a = cellOf(grid, box, x0, y0);
	// Just inside the far edge so an object ending exactly on a cell line does not claim the next cell.
	const b = cellOf(grid, box, Math.max(x0, x1 - 1e-6), Math.max(y0, y1 - 1e-6));
	return a === b ? a : `${a}-${b}`;
}

function cellsOfSpan(span: string): string[] {
	const [a, b] = span.split("-") as [string, string | undefined];
	if (!b) return [a];
	const out: string[] = [];
	for (let r = Number(a.slice(1)); r <= Number(b.slice(1)); r++)
		for (let c = COL_LETTERS.indexOf(a[0] as string); c <= COL_LETTERS.indexOf(b[0] as string); c++) out.push(`${COL_LETTERS[c]}${r}`);
	return out;
}

/** Typed-object ids per grid cell they overlap (cells with none are omitted). */
export function objectsAt(scene: DrawingScene, box: Box): Record<string, string[]> {
	const grid = regionGrid(box);
	const out: Record<string, string[]> = {};
	for (const o of scene.objects) {
		if (!isTypedObject(o)) continue;
		for (const cell of cellsOfSpan(spanOf(o, grid, box))) (out[cell] ??= []).push(o.id);
	}
	return out;
}

// ---- structured text ----

function oneLine(s: string): string {
	return s.replace(/\s*\n\s*/g, " ⏎ ").trim();
}
const cellText = (s: string) => oneLine(s).replace(/\|/g, "\\|");

/** One line per typed object (tables add their markdown rows beneath), in id order. */
export function serializeSceneStructuredText(scene: DrawingScene, box: Box): string {
	const grid = regionGrid(box);
	const typed = scene.objects.filter(isTypedObject).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || a.id.localeCompare(b.id));
	const lines: string[] = [];
	for (const o of typed) {
		const head = `[${o.id} ${o.type} @${spanOf(o, grid, box)}]`;
		if (o.type === "latex") lines.push(`${head} $${oneLine(o.source)}$`);
		else if (o.type === "image") lines.push(`${head} (image ${o.assetId})`);
		else if (o.type !== "table") lines.push(`${head} ${oneLine(o.source)}`);
		else {
			lines.push(head);
			const width = Math.max(1, ...o.cells.map((r) => r.length));
			const row = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cellText(r[i] ?? "")).join(" | ")} |`;
			o.cells.forEach((r, i) => {
				lines.push(row(r));
				if (i === 0) lines.push(`|${" --- |".repeat(width)}`);
			});
		}
	}
	return lines.join("\n");
}

// ---- teacher annotations (PR 3) ----

export type AnnotationTarget = { object: string } | { cell: string } | { cells: string }; // cells: "B2:D3"
export const MARK_KINDS = ["circle", "underline", "check", "cross", "note", "arrow"] as const;
export type AnnotationMark =
	| { kind: "circle" | "underline" | "check" | "cross" | "note"; target: AnnotationTarget; label?: string }
	| { kind: "arrow"; from: AnnotationTarget; to: AnnotationTarget; label?: string };

export const MAX_ANNOTATION_MARKS = 20;
export const MAX_ANNOTATION_LABEL = 80;

function gridRows(box: Box): number {
	return regionGrid(box).rows;
}

/** What a model may legitimately cite for this drawing, appended to refusals so it can retry. */
function validTargetsHint(scene: DrawingScene, box: Box): string {
	const ids = scene.objects.filter(isTypedObject).map((o) => o.id);
	return `valid cells are A1 to H${gridRows(box)}, ranges are written B2:D3` + (ids.length ? `; typed object ids: ${ids.join(", ")}` : "; this drawing has no typed objects (anchor by cell)");
}

function objectRect(o: DrawingObject): Box {
	let x0: number, y0: number, x1: number, y1: number;
	if (o.type === "stroke") {
		const xs = o.points.map((p) => p[0]);
		const ys = o.points.map((p) => p[1]);
		x0 = Math.min(...xs); x1 = Math.max(...xs); y0 = Math.min(...ys); y1 = Math.max(...ys);
	} else if (o.type === "shape") {
		x0 = Math.min(o.x1, o.x2); x1 = Math.max(o.x1, o.x2); y0 = Math.min(o.y1, o.y2); y1 = Math.max(o.y1, o.y2);
	} else {
		x0 = Math.min(o.x, o.x + o.w); x1 = Math.max(o.x, o.x + o.w); y0 = Math.min(o.y, o.y + o.h); y1 = Math.max(o.y, o.y + o.h);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function unionBox(a: Box, b: Box): Box {
	const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
	return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** The world-space rectangle a target points at, or null when it does not resolve in this scene/grid. */
export function resolveTargetRect(target: AnnotationTarget, scene: DrawingScene, box: Box): Box | null {
	const t = target as { object?: unknown; cell?: unknown; cells?: unknown };
	if (typeof t.object === "string") {
		const o = scene.objects.find((x) => x.id === t.object);
		return o ? objectRect(o) : null;
	}
	const grid = regionGrid(box);
	// `cell` and `cells` resolve alike: a model that puts a range in `cell` (or one cell in `cells`) means it.
	const spec = typeof t.cell === "string" ? t.cell : typeof t.cells === "string" ? t.cells : null;
	return spec === null ? null : rangeRect(grid, box, spec);
}

/** A range separator: the colon the tool documents, or the dash the structured text writes spans with (`B6-D7`), or an en/em dash. */
const RANGE_SEP = /\s*[:\-\u2013\u2014]\s*/;
/** The shape of a cell or a range, grid aside ("C4", "B2:D3", "B2-D3"). */
const CELL_SPEC = /^\s*[A-Ha-h]\d{1,2}(\s*[:\-\u2013\u2014]\s*[A-Ha-h]\d{1,2})?\s*$/;

/** One cell or a two-corner range (either corner order), or null when it is not one in this grid. */
function rangeRect(grid: RegionGrid, box: Box, spec: string): Box | null {
	const parts = spec.trim().split(RANGE_SEP);
	if (parts.length === 1) return cellRect(grid, box, parts[0] as string);
	if (parts.length !== 2) return null;
	const a = cellRect(grid, box, parts[0] as string);
	const b = cellRect(grid, box, parts[1] as string);
	return a && b ? unionBox(a, b) : null;
}

function targetProblem(label: string, target: unknown, scene: DrawingScene, box: Box): string | null {
	if (typeof target !== "object" || target === null) return `${label} is missing - give {"object": id}, {"cell": "C4"} or {"cells": "B2:D3"}; ${validTargetsHint(scene, box)}`;
	const t = target as { object?: unknown; cell?: unknown; cells?: unknown };
	const given = [t.object, t.cell, t.cells].filter((v) => v !== undefined).length;
	if (given !== 1) return `${label} must have exactly one of object, cell, cells; ${validTargetsHint(scene, box)}`;
	if (resolveTargetRect(target as AnnotationTarget, scene, box)) return null;
	const what = t.object !== undefined ? `object ${JSON.stringify(t.object)}` : t.cell !== undefined ? `cell ${JSON.stringify(t.cell)}` : `cells ${JSON.stringify(t.cells)}`;
	const spec = t.object === undefined ? (t.cell ?? t.cells) : undefined;
	if (typeof spec === "string" && !CELL_SPEC.test(spec)) {
		return `${label}: ${what} is not a cell or a range - a cell is written C4 and ranges are written B2:D3; ${validTargetsHint(scene, box)}`;
	}
	return `${label}: ${what} does not exist in this drawing; ${validTargetsHint(scene, box)}`;
}

/** Problems with one mark against a scene and its grid box (empty = fine). */
export function annotationMarkProblems(mark: unknown, scene: DrawingScene, box: Box): string[] {
	if (typeof mark !== "object" || mark === null) return ["mark must be an object"];
	const m = mark as { kind?: unknown; target?: unknown; from?: unknown; to?: unknown; label?: unknown };
	const out: string[] = [];
	if (typeof m.kind !== "string" || !(MARK_KINDS as readonly string[]).includes(m.kind)) {
		return [`kind must be one of ${MARK_KINDS.join(", ")}`];
	}
	if (m.label !== undefined && (typeof m.label !== "string" || m.label.length > MAX_ANNOTATION_LABEL)) out.push(`label must be a string of at most ${MAX_ANNOTATION_LABEL} characters`);
	if (m.kind === "arrow") {
		const f = targetProblem("from", m.from, scene, box);
		const t = targetProblem("to", m.to, scene, box);
		if (f) out.push(f);
		if (t) out.push(t);
		if (m.target !== undefined) out.push("an arrow takes `from` and `to`, not `target`");
	} else {
		for (const key of ["from", "to"] as const) {
			if (m[key] !== undefined) out.push(`only arrows take from/to - rename \`${key}\` to \`target\``);
		}
		const t = targetProblem("target", m.target, scene, box);
		if (t) out.push(t);
	}
	return out;
}

// ---- the annotate input contract: ONE schema and ONE heal for the agent boundary and every read of the record ----

const annotationTargetField = Type.Optional(
	Type.Object(
		{
			object: Type.Optional(Type.String({ description: "A typed object id from the drawing's structured text, e.g. o2" })),
			cell: Type.Optional(Type.String({ description: "One grid cell, e.g. C4" })),
			cells: Type.Optional(Type.String({ description: "A grid range, top-left:bottom-right, e.g. B2:D3" })),
		},
		{ description: "Exactly ONE of object, cell, cells" },
	),
);

/** The `annotate` tool's input schema: the agent tool declares it, and parseAnnotateInput reads the record with it. */
export const annotateInputSchema = Type.Object({
	drawingId: Type.String({ description: "The drawing to mark, exactly as the submission names it (drw_...)" }),
	marks: Type.Array(
		Type.Object({
			kind: Type.String({ description: "circle | underline | check | cross | note | arrow" }),
			target: annotationTargetField,
			from: annotationTargetField,
			to: annotationTargetField,
			label: Type.Optional(Type.String({ description: `Short caption (at most ${MAX_ANNOTATION_LABEL} characters)` })),
		}),
		{ minItems: 1, maxItems: MAX_ANNOTATION_MARKS, description: `1 to ${MAX_ANNOTATION_MARKS} marks` },
	),
});

export type AnnotateInput = { drawingId: string; marks: AnnotationMark[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A JSON-encoded object becomes the object; anything else is returned as is. */
function decodedObject(v: unknown): unknown {
	if (typeof v !== "string") return v;
	try {
		const parsed = JSON.parse(v) as unknown;
		return isPlainObject(parsed) ? parsed : v;
	} catch {
		return v;
	}
}

/** Optional fields sent as null mean absent (pi's boundary drops them before validation). */
function withoutNulls(o: Record<string, unknown>): Record<string, unknown> {
	return Object.values(o).includes(null) ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) : o;
}

/**
 * A non-arrow mark that anchors itself the wrong way: exactly one of from/to and no target moves
 * that one into `target`; bare object/cell/cells keys on the mark are wrapped into `target`.
 * Arrows keep from/to untouched. Identity-preserving when nothing applies.
 */
function moveIntoTarget(mark: Record<string, unknown>): Record<string, unknown> {
	if (mark.kind === "arrow" || mark.target !== undefined) return mark;
	const hasFrom = mark.from !== undefined;
	const hasTo = mark.to !== undefined;
	if (hasFrom !== hasTo) {
		const { from, to, ...rest } = mark;
		return { ...rest, target: hasFrom ? from : to };
	}
	if (hasFrom) return mark;
	const bare = (["object", "cell", "cells"] as const).filter((k) => mark[k] !== undefined);
	if (bare.length === 0) return mark;
	const rest = { ...mark };
	const target: Record<string, unknown> = {};
	for (const k of bare) {
		target[k] = mark[k];
		delete rest[k];
	}
	return { ...rest, target };
}

/**
 * The annotate heal: the standard top-level pass (a `marks` array sent as a JSON string) plus the nested
 * wobbles of this one tool - a mark, or a mark's `target`/`from`/`to`, sent as a JSON-encoded object, and
 * optional fields sent as null. Runs at the agent boundary (the tool's prepareArguments) AND in
 * parseAnnotateInput, so a call that succeeded on healed args reads back the same from the RAW record.
 * Well-formed args pass through untouched (same reference); idempotent.
 */
export function healAnnotateArguments(args: unknown): unknown {
	const top = healEncodedArguments(args, annotateInputSchema);
	if (!isPlainObject(top) || !Array.isArray(top.marks)) return top;
	let changed = false;
	const marks = top.marks.map((raw: unknown) => {
		const decoded = decodedObject(raw);
		if (!isPlainObject(decoded)) return raw;
		let mark = withoutNulls(decoded);
		for (const key of ["target", "from", "to"] as const) {
			const t = decodedObject(mark[key]);
			if (!isPlainObject(t)) continue;
			const clean = withoutNulls(t);
			if (clean !== mark[key]) mark = { ...mark, [key]: clean };
		}
		mark = moveIntoTarget(mark);
		if (mark !== raw) changed = true;
		return mark;
	});
	return changed ? { ...top, marks } : top;
}

/**
 * Annotate arguments for READ (the fold, the card, the session markdown): heal, then the boundary's
 * Convert + Check against the same schema, then the structural mark shape (a known kind; an arrow has
 * from and to, every other mark a target). Undefined when the call could never have been accepted.
 */
export function parseAnnotateInput(raw: unknown): AnnotateInput | undefined {
	const healed = healAnnotateArguments(raw);
	if (!isPlainObject(healed)) return undefined;
	const value = structuredClone(healed);
	Value.Convert(annotateInputSchema, value);
	if (!Value.Check(annotateInputSchema, value)) return undefined;
	const clean = Value.Clean(annotateInputSchema, value) as { drawingId: string; marks: Record<string, unknown>[] };
	const wellFormed = clean.marks.every((m) =>
		(MARK_KINDS as readonly string[]).includes(m.kind as string) && (m.kind === "arrow" ? m.from !== undefined && m.to !== undefined : m.target !== undefined),
	);
	return wellFormed ? (clean as AnnotateInput) : undefined;
}

/** How a target reads in text: its object id, cell or range ("?" when it has none). */
export function annotationTargetText(target: unknown): string {
	const t = (isPlainObject(target) ? target : {}) as Partial<Record<"object" | "cell" | "cells", unknown>>;
	const v = t.object ?? t.cell ?? t.cells;
	return typeof v === "string" ? v : "?";
}

/** Where one mark points, in text: "o2", "B2:D3", or "A1 → C4" for an arrow. */
export function annotationMarkPlace(mark: AnnotationMark): string {
	return mark.kind === "arrow" ? `${annotationTargetText(mark.from)} \u2192 ${annotationTargetText(mark.to)}` : annotationTargetText(mark.target);
}

/** Ids of annotate calls that really happened: a result exists and is neither isError nor {ok:false}. */
function succeededCallIds(messages: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		const r = m as { role?: string; toolCallId?: string; isError?: boolean; details?: unknown };
		if (r.role !== "toolResult" || typeof r.toolCallId !== "string" || r.isError) continue;
		if ((r.details as { ok?: unknown } | null | undefined)?.ok === false) continue;
		ids.add(r.toolCallId);
	}
	return ids;
}

/** The marks the teacher drew on one drawing: a pure fold over successful `annotate` calls, in call order. */
export function annotationsOf(messages: readonly unknown[], drawingId: string): { callId: string; marks: AnnotationMark[] }[] {
	const ok = succeededCallIds(messages);
	const out: { callId: string; marks: AnnotationMark[] }[] = [];
	for (const m of messages) {
		const a = m as { role?: string; content?: unknown };
		if (a.role !== "assistant" || !Array.isArray(a.content)) continue;
		for (const b of a.content as { type?: string; name?: string; id?: string; arguments?: unknown }[]) {
			if (b.type !== "toolCall" || b.name !== "annotate" || typeof b.id !== "string" || !ok.has(b.id)) continue;
			// The record keeps RAW arguments (the tool-parts law): parse them through the same heal the
			// boundary ran, or a call that succeeded on healed args folds to nothing.
			const args = parseAnnotateInput(b.arguments);
			if (args?.drawingId !== drawingId) continue;
			out.push({ callId: b.id, marks: args.marks });
		}
	}
	return out;
}

/** Drawing ids the learner submitted for one task (a work call or a practice problem), oldest first, deduplicated. */
export function submittedDrawingIds(messages: readonly unknown[], taskCallId: string): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		const r = m as { role?: string; customType?: string; details?: { workCallId?: unknown; problemCallId?: unknown; drawingId?: unknown } | null };
		if (r.role !== "custom") continue;
		const task = r.customType === "work-submission" ? r.details?.workCallId : r.customType === "practice-thinking" ? r.details?.problemCallId : undefined;
		const id = r.details?.drawingId;
		if (task === taskCallId && typeof id === "string" && !ids.includes(id)) ids.push(id);
	}
	return ids;
}
