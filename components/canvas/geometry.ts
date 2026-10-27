/**
 * Pure canvas geometry (canvas workspace, PR 2): stroke outlines, view maps, hit-test/erase, the
 * theme-neutral palette, point quantization and viewport culling. No DOM, so node tests pin it.
 * Zoom and pinch are NOT here: the engine reuses zoomedGraphView / pinchView from ../pan-zoom.ts.
 */
import { getStroke } from "perfect-freehand";
import type { Box, Brush, DrawingObject, DrawingScene, ShapeObject, StrokeObject } from "@/src/core";
import type { Viewport } from "../pan-zoom.ts";

export type CanvasTool = "select" | "pan" | "pen" | "pencil" | "marker" | "line" | "arrow" | "rect" | "ellipse" | "eraser" | "text" | "markdown" | "latex" | "table" | "image";
export type Pt = { x: number; y: number };

/** Zoom floor of the canvas (the ceiling is the shared ZOOM_MAX). */
export const CANVAS_ZOOM_MIN = 0.1;

// ---- touch policy ----

/** One finger draws until a pen has been seen (page lifetime), then it pans; two touches always pan/pinch. */
export function touchRole(penSeen: boolean, touchCount: number): "draw" | "pan" {
	return touchCount >= 2 || penSeen ? "pan" : "draw";
}

// ---- view maps ----

export function screenToWorld(view: Viewport, p: Pt): Pt {
	return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
}
export function worldToScreen(view: Viewport, p: Pt): Pt {
	return { x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y };
}

// ---- palette ----

export const PALETTE_NAMES = ["ink", "red", "blue", "green", "orange", "purple", "gray", "highlight"] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];
const LIGHT: Record<PaletteName, string> = { ink: "#1a1a1a", red: "#d62828", blue: "#1d4ed8", green: "#15803d", orange: "#c2410c", purple: "#7e22ce", gray: "#6b7280", highlight: "#facc15" };
const DARK: Record<PaletteName, string> = { ink: "#f5f5f5", red: "#f87171", blue: "#60a5fa", green: "#4ade80", orange: "#fb923c", purple: "#c084fc", gray: "#9ca3af", highlight: "#fde047" };
const isName = (c: string): c is PaletteName => (PALETTE_NAMES as readonly string[]).includes(c);

/** On-screen colour of a stored colour (a palette name; any other string, e.g. a hex, passes through). */
export function screenColor(color: string, theme: "light" | "dark"): string {
	return isName(color) ? (theme === "dark" ? DARK : LIGHT)[color] : color;
}
/** Export colour: always the light set (dark ink on white), whatever the theme. */
export function exportColor(color: string): string {
	return screenColor(color, "light");
}

// ---- points and outlines ----

/** Stored precision: x/y 0.1, pressure 0.01 (rounded through the step so 0.46 stays 0.46). */
export function quantizePoint(x: number, y: number, pressure: number): [number, number, number] {
	return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(pressure * 100) / 100];
}

export const BRUSH_PRESETS: Record<Brush, { thinning: number; smoothing: number; streamline: number }> = {
	pen: { thinning: 0.6, smoothing: 0.5, streamline: 0.4 },
	pencil: { thinning: 0.2, smoothing: 0.3, streamline: 0.2 },
	marker: { thinning: 0, smoothing: 0.6, streamline: 0.5 },
};

/** Outline polygon of a stroke. Constant pressure (mouse/finger) means simulated pressure. */
export function strokeOutline(points: readonly (readonly number[])[], brush: Brush, size: number): [number, number][] {
	const first = points[0]?.[2];
	const simulatePressure = points.every((p) => p[2] === first);
	return getStroke(points as number[][], { size, ...BRUSH_PRESETS[brush], simulatePressure }) as [number, number][];
}

// ---- bounds, culling ----

const boxCache = new WeakMap<DrawingObject, Box>();
export function objectBox(o: DrawingObject): Box {
	const hit = boxCache.get(o);
	if (hit) return hit;
	let x0: number, y0: number, x1: number, y1: number;
	if (o.type === "stroke") {
		x0 = y0 = Infinity;
		x1 = y1 = -Infinity;
		for (const p of o.points) {
			if (p[0] < x0) x0 = p[0];
			if (p[0] > x1) x1 = p[0];
			if (p[1] < y0) y0 = p[1];
			if (p[1] > y1) y1 = p[1];
		}
		const pad = o.size;
		x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
	} else if (o.type === "shape") {
		const pad = o.strokeWidth + 8;
		x0 = Math.min(o.x1, o.x2) - pad; x1 = Math.max(o.x1, o.x2) + pad;
		y0 = Math.min(o.y1, o.y2) - pad; y1 = Math.max(o.y1, o.y2) + pad;
	} else {
		x0 = Math.min(o.x, o.x + o.w); x1 = Math.max(o.x, o.x + o.w);
		y0 = Math.min(o.y, o.y + o.h); y1 = Math.max(o.y, o.y + o.h);
	}
	const box = Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
	boxCache.set(o, box);
	return box;
}

const overlaps = (a: Box, b: Box) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

/** The objects whose bounds meet the world-space view box, in paint order (z, then scene order). */
export function visibleObjects(scene: DrawingScene, viewBox: Box): DrawingObject[] {
	const out = scene.objects.filter((o) => overlaps(objectBox(o), viewBox));
	return out.map((o, i) => [o, i] as const).sort((a, b) => a[0].z - b[0].z || a[1] - b[1]).map((e) => e[0]);
}

// ---- hit test, erase ----

function segDist(p: Pt, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2));
	return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
}

function strokeDist(o: StrokeObject, p: Pt): number {
	const pts = o.points;
	if (pts.length === 1) return Math.hypot(p.x - pts[0]![0], p.y - pts[0]![1]);
	let d = Infinity;
	for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]));
	return d - o.size / 2;
}

function shapeDist(o: ShapeObject, p: Pt): number {
	const { x1, y1, x2, y2 } = o;
	let d: number;
	if (o.shape === "line" || o.shape === "arrow") d = segDist(p, x1, y1, x2, y2);
	else if (o.shape === "rect") {
		const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
		d = Math.min(segDist(p, l, t, r, t), segDist(p, r, t, r, b), segDist(p, r, b, l, b), segDist(p, l, b, l, t));
	} else {
		const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
		const rx = Math.max(Math.abs(x2 - x1) / 2, 1e-6), ry = Math.max(Math.abs(y2 - y1) / 2, 1e-6);
		const nx = (p.x - cx) / rx, ny = (p.y - cy) / ry;
		d = Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
	}
	return d - o.strokeWidth / 2;
}

function distTo(o: DrawingObject, p: Pt): number {
	if (o.type === "stroke") return strokeDist(o, p);
	if (o.type === "shape") return shapeDist(o, p);
	const b = objectBox(o);
	return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h ? 0 : Infinity;
}

/** Id of the topmost object within `radius` of the world point, or null. */
export function hitTest(scene: DrawingScene, p: Pt, radius: number): string | null {
	let best: DrawingObject | null = null;
	let bestIdx = -1;
	scene.objects.forEach((o, i) => {
		if (!overlaps(objectBox(o), { x: p.x - radius, y: p.y - radius, w: 2 * radius, h: 2 * radius })) return;
		if (distTo(o, p) > radius) return;
		if (!best || o.z > best.z || (o.z === best.z && i > bestIdx)) { best = o; bestIdx = i; }
	});
	return best ? (best as DrawingObject).id : null;
}

/** The scene without every object the eraser touches (whole objects; the same scene when none). */
export function eraseAt(scene: DrawingScene, p: Pt, radius: number): DrawingScene {
	const near = { x: p.x - radius, y: p.y - radius, w: 2 * radius, h: 2 * radius };
	const kept = scene.objects.filter((o) => !(overlaps(objectBox(o), near) && distTo(o, p) <= radius));
	return kept.length === scene.objects.length ? scene : { ...scene, objects: kept };
}

/** Pasted/uploaded images are stored at most this many px on the long side. */
export const IMAGE_MAX_SIDE = 1600;

/** Target size for an image whose long side may not exceed `max`; never upscales, keeps the aspect ratio. */
export function fitImageSize(w: number, h: number, max: number = IMAGE_MAX_SIDE): { w: number; h: number } {
	const long = Math.max(w, h);
	if (!(long > max)) return { w, h };
	const k = max / long;
	return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
