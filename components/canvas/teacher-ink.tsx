/**
 * TEACHER INK (PR 3): the marks the agent drew with `annotate`, rendered over a drawing.
 * Marks are anchored (object id / grid cell / range), so each is resolved to a world rectangle against the
 * scene and the grid box (`resolveTargetRect`); a mark that no longer resolves is skipped.
 *
 * - space "world": a `<g>` in world coordinates, to sit inside an svg carrying the viewport transform.
 * - space "percent": a standalone `<svg>` laid over a thumbnail of the scene box; units are percent of
 *   the box width on both axes (viewBox 0 0 100 100*h/w), so glyphs keep their proportions.
 * Colours go through the palette helper (TEACHER_INK_COLOR); the thumbnail PNG is always light.
 *
 * The red-pen hand (B2, owner's pick, 2026-10-28): every mark is a hand-drawn path (`wobblePath`, jitter seeded
 * by the mark's content and index, so a re-render never re-wobbles), red but for the green check, and notes
 * and labels are written in Shantell Sans (next/font, `--font-teacher-hand`) over a paper-coloured halo so
 * they stay readable on top of the learner's strokes. A label takes its mark's colour.
 */

import { resolveTargetRect, type AnnotationMark, type AnnotationTarget, type Box, type DrawingScene } from "@/src/core";
import { screenColor, TEACHER_INK_COLOR } from "./geometry";

export interface TeacherInkProps {
	marks: readonly AnnotationMark[];
	scene: DrawingScene;
	/** The grid box of the submitted drawing (sceneBoundingBox). */
	box: Box;
	space: "world" | "percent";
	theme?: "light" | "dark";
}

interface Ctx {
	k: number; // world -> space scale
	ox: number;
	oy: number;
	u: number; // base unit in space coordinates (stroke width, glyph size)
	/** The red pen (TEACHER_INK_COLOR) and the green one (the check). */
	red: string;
	green: string;
	/** The note halo: the opposite-theme ink, so text stays legible on any ground. */
	paper: string;
	/** Extent of the drawing in space coordinates; notes are kept inside it. */
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	/** Note font size in space coordinates (noteSize). */
	fs: number;
}

type R = { x: number; y: number; w: number; h: number };
const f = (n: number) => Math.round(n * 100) / 100;

function rectOf(target: AnnotationTarget | undefined, scene: DrawingScene, box: Box, c: Ctx): R | null {
	if (!target) return null;
	const r = resolveTargetRect(target, scene, box);
	return r ? { x: (r.x - c.ox) * c.k, y: (r.y - c.oy) * c.k, w: r.w * c.k, h: r.h * c.k } : null;
}

/** mulberry32: a tiny seeded PRNG in [0, 1). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** FNV-1a over a string: the per-mark wobble seed. */
function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

/**
 * A hand-drawn stroke through `points`: each point jittered by up to `amp` (seeded, so equal inputs give the
 * same path), joined with quadratic smoothing (each inner point is a control, the curve runs through the
 * midpoints). A repeated point makes a sharp corner (the check's vertex).
 */
export function wobblePath(points: Array<[number, number]>, seed: number, amp: number): string {
	const rnd = mulberry32(seed);
	const p = points.map(([x, y]) => [x + (rnd() * 2 - 1) * amp, y + (rnd() * 2 - 1) * amp] as const);
	const first = p[0];
	if (!first) return "";
	let d = `M${f(first[0])} ${f(first[1])}`;
	for (let i = 1; i < p.length - 1; i++) {
		const [cx, cy] = p[i]!;
		const [nx, ny] = p[i + 1]!;
		d += `Q${f(cx)} ${f(cy)} ${f((cx + nx) / 2)} ${f((cy + ny) / 2)}`;
	}
	const last = p[p.length - 1]!;
	return p.length > 1 ? `${d}L${f(last[0])} ${f(last[1])}` : d;
}

const NOTE_LINE_CHARS = 24;
const NOTE_MAX_LINES = 2;
/** Shantell Sans runs about 0.6em per character. */
const NOTE_CHAR_EM = 0.6;

/**
 * The note size: today's badge size x 1.15 (u*2.6*1.15). The chat thumbnail is drawn at most 160px tall
 * (DrawingThumb, max-h-40), where that comes out near 6px, so in percent space a note is at least 7% of the
 * box height (about 11px there; owner: "clearly readable", 2026-10-28). In world space (the workspace, zoom 1
 * by default) a note is at least 14 world px, i.e. 14px unzoomed; it is not counter-scaled with the zoom,
 * which is the learner's choice. Never so large that a full line overflows the drawing's width.
 */
function noteSize(u: number, percent: boolean, w: number, h: number): number {
	const base = u * 2.6 * 1.15;
	const size = Math.max(base, percent ? h * 0.07 : 14);
	return Math.min(size, w / (NOTE_LINE_CHARS * NOTE_CHAR_EM));
}

/** Word-wrap at NOTE_LINE_CHARS into NOTE_MAX_LINES lines at most (an overlong word is split), cut with an ellipsis beyond. */
function noteLines(text: string): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.trim().split(/\s+/)) {
		let w = word;
		while (w.length > 0) {
			const room = line ? NOTE_LINE_CHARS - line.length - 1 : NOTE_LINE_CHARS;
			if (w.length <= room) {
				line = line ? `${line} ${w}` : w;
				w = "";
			} else if (line) {
				lines.push(line);
				line = "";
			} else {
				lines.push(w.slice(0, NOTE_LINE_CHARS));
				w = w.slice(NOTE_LINE_CHARS);
			}
		}
	}
	if (line) lines.push(line);
	if (lines.length <= NOTE_MAX_LINES) return lines;
	const kept = lines.slice(0, NOTE_MAX_LINES);
	const lastLine = kept[NOTE_MAX_LINES - 1]!;
	kept[NOTE_MAX_LINES - 1] = `${lastLine.length >= NOTE_LINE_CHARS ? lastLine.slice(0, NOTE_LINE_CHARS - 1) : lastLine}…`;
	return kept;
}

/** Where a note goes: it hangs below `bottom` or stands on `top` (the mark's extent), at `x`. */
interface NoteSpot {
	x: number;
	top: number;
	bottom: number;
	prefer: "above" | "below";
	text: string;
}

/**
 * A note's lines and box, kept inside the drawing: below `bottom` or on `top`, on the preferred side when
 * the drawing has room there, else on the other, else clamped in. Pure: HandNote draws exactly this box, and
 * teacherInkBoxes reports it (the workspace brings it into view).
 */
function notePlace({ x: x0, top, bottom, prefer, text }: NoteSpot, c: Ctx): R & { lines: string[]; lh: number } {
	const fs = c.fs;
	const lh = fs * 1.2;
	const lines = noteLines(text);
	const w = Math.max(...lines.map((l) => l.length), 2) * fs * NOTE_CHAR_EM;
	const h = lines.length * lh;
	const x = Math.max(c.minX, Math.min(x0, c.maxX - w));
	const fitsBelow = bottom + h <= c.maxY, fitsAbove = top - h >= c.minY;
	const below = prefer === "below" ? fitsBelow || !fitsAbove : fitsBelow && !fitsAbove;
	const y = Math.max(c.minY, Math.min(below ? bottom : top - h, c.maxY - h));
	return { x, y, w, h, lines, lh };
}

/**
 * A note in the teacher's hand: Shantell Sans over a paper halo (`paint-order="stroke"`), at most two lines,
 * placed by notePlace. The full text stays in the tooltip (and the AnnotateCard).
 */
function HandNote({ spot, color, c }: { spot: NoteSpot; color: string; c: Ctx }) {
	const fs = c.fs; // the halo below is fs*0.4: u*1.2 at the base size, growing with a floored note
	const { x, y, lines, lh } = notePlace(spot, c);
	return (
		<g>
			<title>{spot.text}</title>
			<text
				fontSize={f(fs)}
				fill={color}
				stroke={c.paper}
				strokeWidth={f(fs * 0.4)}
				strokeLinejoin="round"
				paintOrder="stroke"
				fontFamily="var(--font-teacher-hand), 'Shantell Sans', cursive"
				fontWeight={500}
			>
				{lines.map((l, i) => (
					<tspan key={i} x={f(x)} y={f(y + fs * 0.9 + i * lh)}>
						{l}
					</tspan>
				))}
			</text>
		</g>
	);
}

/** One mark's geometry in space coordinates: what Mark draws, the extent it covers, and where its note goes.
 *  Null when an anchor no longer resolves. */
type MarkGeometry =
	| { kind: "arrow"; x1: number; y1: number; x2: number; y2: number; mx: number; my: number; hl: number; extent: R; note: NoteSpot | null }
	| { kind: "circle"; pts: Array<[number, number]>; extent: R; note: NoteSpot | null }
	| { kind: "underline"; pts: Array<[number, number]>; extent: R; note: NoteSpot | null }
	| { kind: "check" | "cross"; r: R; g: number; extent: R; note: NoteSpot | null }
	| { kind: "note"; extent: null; note: NoteSpot };

const grow = (r: R, d: number): R => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

function markGeometry(mark: AnnotationMark, scene: DrawingScene, box: Box, c: Ctx): MarkGeometry | null {
	if (mark.kind === "arrow") {
		const a = rectOf(mark.from, scene, box, c);
		const b = rectOf(mark.to, scene, box, c);
		if (!a || !b) return null;
		const x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
		// A slightly curved shaft: the middle bowed off the straight line by 6% of its length.
		const bow = 0.06;
		const mx = (x1 + x2) / 2 - (y2 - y1) * bow, my = (y1 + y2) / 2 + (x2 - x1) * bow;
		const hl = c.u * 4;
		const lx = Math.min(x1, x2, mx), ly = Math.min(y1, y2, my);
		const extent = grow({ x: lx, y: ly, w: Math.max(x1, x2, mx) - lx, h: Math.max(y1, y2, my) - ly }, hl);
		// The label sits clear of the shaft: right of the bowed middle, and below (or above) it by a unit.
		const note: NoteSpot | null = mark.label
			? { x: Math.max((x1 + x2) / 2, mx) + c.u, top: Math.min((y1 + y2) / 2, my) - c.u, bottom: Math.max((y1 + y2) / 2, my) + c.u, prefer: "below", text: mark.label }
			: null;
		return { kind: "arrow", x1, y1, x2, y2, mx, my, hl, extent, note };
	}
	const r = rectOf(mark.target, scene, box, c);
	if (!r) return null;
	const g = c.u * 4; // glyph size
	// A label sits clear of its mark (never on the underline or the circle's rim, which its halo would erase),
	// below it, or above when the drawing has no room below.
	const label = (top: number, bottom: number): NoteSpot | null => (mark.label ? { x: r.x, top, bottom, prefer: "below", text: mark.label } : null);
	switch (mark.kind) {
		case "circle": {
			// About 14 points round the ellipse, overshooting the start by ~25 degrees, like a pen loop.
			const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = (r.w / 2) * 1.2 + c.u * 2, ry = (r.h / 2) * 1.2 + c.u * 2;
			const n = 14, from = (-150 * Math.PI) / 180, sweep = ((360 + 25) * Math.PI) / 180;
			const pts = Array.from({ length: n }, (_, i): [number, number] => {
				const t = from + (sweep * i) / (n - 1);
				return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
			});
			return { kind: "circle", pts, extent: grow({ x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry }, c.u), note: label(cy - ry - c.u, cy + ry + c.u) };
		}
		case "underline": {
			const y = r.y + r.h + c.u;
			const pts = [0, 1 / 3, 2 / 3, 1].map((t): [number, number] => [r.x + r.w * t, y]);
			return { kind: "underline", pts, extent: grow({ x: r.x, y: y, w: r.w, h: 0 }, c.u), note: label(r.y - c.u, y + c.u) };
		}
		case "check":
			return { kind: "check", r, g, extent: grow({ x: r.x + r.w - g, y: r.y - g * 0.7, w: g * 1.3, h: g * 1.1 }, c.u), note: label(r.y - g * 0.7 - c.u, r.y + r.h + c.u) };
		case "cross":
			return { kind: "cross", r, g, extent: grow({ x: r.x + r.w - g * 0.5, y: r.y - g * 0.5, w: g, h: g }, c.u), note: label(r.y - g * 0.7 - c.u, r.y + r.h + c.u) };
		case "note":
			return { kind: "note", extent: null, note: { x: r.x + r.w, top: r.y, bottom: r.y + r.h, prefer: "above", text: mark.label ?? "note" } };
	}
}

function Mark({ mark, seed, scene, box, c }: { mark: AnnotationMark; seed: number; scene: DrawingScene; box: Box; c: Ctx }) {
	const geo = markGeometry(mark, scene, box, c);
	if (!geo) return null;
	const color = mark.kind === "check" ? c.green : c.red;
	const sw = f(c.u);
	const common = { fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
	const note = geo.note ? <HandNote spot={geo.note} color={color} c={c} /> : null;
	switch (geo.kind) {
		case "arrow": {
			const { x1, y1, x2, y2, mx, my, hl } = geo;
			const ang = Math.atan2(y2 - my, x2 - mx);
			const barb = (d: number): [number, number] => [x2 - hl * Math.cos(ang + d), y2 - hl * Math.sin(ang + d)];
			const head = wobblePath([[x2, y2], barb(-0.45)], seed + 1, c.u * 0.25) + wobblePath([[x2, y2], barb(0.45)], seed + 2, c.u * 0.25);
			return (
				<g data-mark="arrow">
					<path d={wobblePath([[x1, y1], [mx, my], [x2, y2]], seed, c.u * 0.5)} {...common} />
					<path d={head} {...common} />
					{note}
				</g>
			);
		}
		case "circle":
			return (
				<g data-mark="circle">
					<path d={wobblePath(geo.pts, seed, c.u * 0.6)} {...common} />
					{note}
				</g>
			);
		case "underline":
			return (
				<g data-mark="underline">
					<path d={wobblePath(geo.pts, seed, c.u * 0.5)} {...common} />
					{note}
				</g>
			);
		case "check": {
			const { r, g } = geo;
			const vertex: [number, number] = [r.x + r.w - g * 0.6, r.y + g * 0.4];
			const pts: Array<[number, number]> = [[r.x + r.w - g, r.y - g * 0.1], vertex, vertex, [r.x + r.w + g * 0.3, r.y - g * 0.7]];
			return (
				<g data-mark="check">
					<path d={wobblePath(pts, seed, c.u * 0.25)} {...common} strokeWidth={f(c.u * 1.3)} />
					{note}
				</g>
			);
		}
		case "cross": {
			const { r, g } = geo;
			const [l, rt, t, b] = [r.x + r.w - g * 0.5, r.x + r.w + g * 0.5, r.y - g * 0.5, r.y + g * 0.5];
			const d = wobblePath([[l, t], [(l + rt) / 2, (t + b) / 2], [rt, b]], seed, c.u * 0.25) + wobblePath([[rt, t], [(l + rt) / 2, (t + b) / 2], [l, b]], seed + 1, c.u * 0.25);
			return (
				<g data-mark="cross">
					<path d={d} {...common} strokeWidth={f(c.u * 1.3)} />
					{note}
				</g>
			);
		}
		case "note":
			return <g data-mark="note">{note}</g>;
	}
}

function inkContext(box: Box, space: "world" | "percent", theme: "light" | "dark"): Ctx {
	const percent = space === "percent";
	const k = percent ? 100 / Math.max(box.w, 1) : 1;
	// Base unit: 3 world px, but never thinner than 1/120 of the box width (so a thumbnail still shows it).
	const worldUnit = Math.max(3, box.w / 120);
	const ox = percent ? box.x : 0, oy = percent ? box.y : 0;
	return {
		k,
		ox,
		oy,
		u: worldUnit * k,
		red: screenColor(TEACHER_INK_COLOR, theme),
		green: screenColor("green", theme),
		paper: screenColor("ink", theme === "dark" ? "light" : "dark"),
		minX: (box.x - ox) * k,
		maxX: (box.x + box.w - ox) * k,
		minY: (box.y - oy) * k,
		maxY: (box.y + box.h - oy) * k,
		fs: noteSize(worldUnit * k, percent, box.w * k, box.h * k),
	};
}

/** Pure: the world-space boxes the marks cover as drawn in the workspace, each mark's extent and each note's
 *  box (the same geometry TeacherInk draws), in mark order; a mark that no longer resolves gives none. */
export function teacherInkBoxes(marks: readonly AnnotationMark[], scene: DrawingScene, box: Box): Box[] {
	const c = inkContext(box, "world", "dark");
	const out: Box[] = [];
	for (const m of marks) {
		const geo = markGeometry(m, scene, box, c);
		if (!geo) continue;
		if (geo.extent) out.push(geo.extent);
		if (geo.note) {
			const { x, y, w, h } = notePlace(geo.note, c);
			out.push({ x, y, w, h });
		}
	}
	return out;
}

export function TeacherInk({ marks, scene, box, space, theme = "dark" }: TeacherInkProps) {
	const c = inkContext(box, space, theme);
	const body = (
		<g data-testid="teacher-ink">
			{marks.map((m, i) => (
				<Mark key={i} mark={m} seed={hashString(JSON.stringify(m)) + i} scene={scene} box={box} c={c} />
			))}
		</g>
	);
	if (space !== "percent") return body;
	return (
		<svg viewBox={`0 0 100 ${f((100 * Math.max(box.h, 1)) / Math.max(box.w, 1))}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
			{body}
		</svg>
	);
}
