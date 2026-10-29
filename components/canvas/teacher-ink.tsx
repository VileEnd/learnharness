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
 *
 * Notes (0.29.0, owner: "without destroying the notes"): a note is never shortened, it wraps into as many
 * lines as it needs. Its spot comes from layoutNotes (note-layout.ts), clear of every mark's drawn extent, of
 * the learner's typed objects and of the notes before it (freehand strokes are not obstacles; the halo keeps
 * the text readable over them). Notes may sit beyond the drawing: the workspace is infinite and its reveal
 * brings them into view, and the thumbnail's paper grows to hold them (teacherInkView). The tutor's grid box
 * never grows, so anchors keep resolving to the same cells. A note pushed away from its mark gets a thin
 * leader in the mark's colour.
 */

import { isTypedObject, resolveTargetRect, type AnnotationMark, type AnnotationTarget, type Box, type DrawingScene } from "@/src/core";
import { screenColor, TEACHER_INK_COLOR } from "./geometry";
import { layoutNotes, type Side } from "./note-layout.ts";

export interface TeacherInkProps {
	marks: readonly AnnotationMark[];
	scene: DrawingScene;
	/** The grid box of the submitted drawing (sceneBoundingBox). */
	box: Box;
	space: "world" | "percent";
	theme?: "light" | "dark";
	/** World space only: the workspace's current zoom, so a note's text keeps NOTE_SCREEN_MIN_PX on screen. */
	zoom?: number;
	/** World space only: each mark's note side, solved once per marking turn (teacherNoteSides), so a note keeps
	 *  its spot while the learner zooms. Absent: solved freely. */
	sides?: readonly (Side | undefined)[];
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
	/** Note font size in space coordinates (noteSize). */
	fs: number;
}

type R = { x: number; y: number; w: number; h: number };
const f = (n: number) => Math.round(n * 100) / 100;

/** A world rectangle in space coordinates. */
const toSpace = (r: Box, c: Ctx): R => ({ x: (r.x - c.ox) * c.k, y: (r.y - c.oy) * c.k, w: r.w * c.k, h: r.h * c.k });

function rectOf(target: AnnotationTarget | undefined, scene: DrawingScene, box: Box, c: Ctx): R | null {
	if (!target) return null;
	const r = resolveTargetRect(target, scene, box);
	return r ? toSpace(r, c) : null;
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
/** Shantell Sans runs about 0.6em per character. */
const NOTE_CHAR_EM = 0.6;
/** A note's halo reaches 0.2em beyond its glyphs; a note's box holds it, so two boxes apart are two readable notes. */
const NOTE_HALO_EM = 0.2;
/** How far a note sits clear of its mark, and each outward step when it is crowded out (layoutNotes): half a
 *  line, so the six steps reach about three lines out (a third of a line left a crowded thumbnail overlapping). */
const NOTE_GAP_EM = 0.6;

/** The smallest a workspace note's text is drawn on screen, in px, whatever the zoom ("clearly readable"). */
export const NOTE_SCREEN_MIN_PX = 13;

/**
 * The note size: today's badge size x 1.15 (u*2.6*1.15). The chat thumbnail is drawn at most 160px tall
 * (DrawingThumb, max-h-40), where that comes out near 6px, so in percent space a note is at least 7% of the
 * box height (about 11px there; owner: "clearly readable", 2026-10-28). In world space (the workspace, zoom 1
 * by default) a note is at least 14 world px, i.e. 14px unzoomed. Never so large that a full line overflows
 * the drawing's width, except that a workspace note never drops below NOTE_SCREEN_MIN_PX on screen at the
 * current `zoom` (13 / zoom world px): when the two conflict the floor wins and the note wraps as usual (the
 * marks themselves keep scaling with the drawing).
 */
function noteSize(u: number, percent: boolean, w: number, h: number, zoom = 1): number {
	const base = u * 2.6 * 1.15;
	const size = Math.min(Math.max(base, percent ? h * 0.07 : 14), w / (NOTE_LINE_CHARS * NOTE_CHAR_EM));
	return percent ? size : Math.max(size, NOTE_SCREEN_MIN_PX / Math.max(zoom, 1e-6));
}

/** Word-wrap at NOTE_LINE_CHARS, into as many lines as the text needs (an overlong word is split). Never cut. */
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
	return lines;
}

/** What a note hangs on: its mark's box (the spots go round it), the side it prefers, its text. */
interface NoteAnchor {
	markBox: R;
	prefer?: Side;
	text: string;
}

/** A placed note: its box (halo included), its lines, and the leader to its mark when it was pushed away. */
interface PlacedNoteInk {
	box: R;
	side: Side;
	lines: string[];
	text: string;
	leader: [number, number, number, number] | null;
}

/** The leader: from the note's edge midpoint nearest the mark to the mark box's nearest point. */
function leaderLine(note: R, mark: R): [number, number, number, number] {
	const mids: Array<[number, number]> = [
		[note.x + note.w / 2, note.y],
		[note.x + note.w / 2, note.y + note.h],
		[note.x, note.y + note.h / 2],
		[note.x + note.w, note.y + note.h / 2],
	];
	let best: [number, number, number, number] = [0, 0, 0, 0];
	let bestD = Infinity;
	for (const [px, py] of mids) {
		const qx = Math.max(mark.x, Math.min(px, mark.x + mark.w)), qy = Math.max(mark.y, Math.min(py, mark.y + mark.h));
		const d = (px - qx) ** 2 + (py - qy) ** 2;
		if (d < bestD) [bestD, best] = [d, [px, py, qx, qy]];
	}
	return best;
}

/**
 * A note in the teacher's hand: Shantell Sans over a paper halo (`paint-order="stroke"`), every line of it,
 * in the box layoutInk placed, behind a leader when it was pushed away. The full text stays in the tooltip
 * (and the AnnotateCard).
 */
function HandNote({ note, color, c }: { note: PlacedNoteInk; color: string; c: Ctx }) {
	const fs = c.fs; // the halo below is fs*0.4: u*1.2 at the base size, growing with a floored note
	const lh = fs * 1.2, m = fs * NOTE_HALO_EM;
	const { box, lines, leader } = note;
	return (
		<g>
			{leader ? <line x1={f(leader[0])} y1={f(leader[1])} x2={f(leader[2])} y2={f(leader[3])} stroke={color} strokeWidth={f(c.u * 0.5)} strokeLinecap="round" data-leader="" /> : null}
			<title>{note.text}</title>
			<text
				fontSize={f(fs)}
				fill={color}
				stroke={c.paper}
				strokeWidth={f(fs * 2 * NOTE_HALO_EM)}
				strokeLinejoin="round"
				paintOrder="stroke"
				fontFamily="var(--font-teacher-hand), 'Shantell Sans', cursive"
				fontWeight={500}
			>
				{lines.map((l, i) => (
					<tspan key={i} x={f(box.x + m)} y={f(box.y + m + fs * 0.9 + i * lh)}>
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
	| { kind: "arrow"; x1: number; y1: number; x2: number; y2: number; mx: number; my: number; hl: number; extent: R; note: NoteAnchor | null }
	| { kind: "circle"; pts: Array<[number, number]>; extent: R; note: NoteAnchor | null }
	| { kind: "underline"; pts: Array<[number, number]>; extent: R; note: NoteAnchor | null }
	| { kind: "check" | "cross"; r: R; g: number; extent: R; note: NoteAnchor | null }
	| { kind: "note"; extent: null; note: NoteAnchor };

const grow = (r: R, d: number): R => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
function union(a: R, b: R): R {
	const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
	return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

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
		// The label sits clear of the shaft: beside a mostly vertical arrow (level with its middle), under a mostly
		// horizontal one.
		const note: NoteAnchor | null = mark.label ? { markBox: extent, prefer: Math.abs(y2 - y1) > Math.abs(x2 - x1) ? "right" : "below", text: mark.label } : null;
		return { kind: "arrow", x1, y1, x2, y2, mx, my, hl, extent, note };
	}
	const r = rectOf(mark.target, scene, box, c);
	if (!r) return null;
	const g = c.u * 4; // glyph size
	// A label sits clear of its mark (never on the underline or the circle's rim, which its halo would erase), and
	// of what it marks: below both, else wherever layoutNotes finds room.
	const label = (extent: R): NoteAnchor | null => (mark.label ? { markBox: union(r, extent), text: mark.label } : null);
	switch (mark.kind) {
		case "circle": {
			// About 14 points round the ellipse, overshooting the start by ~25 degrees, like a pen loop.
			const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = (r.w / 2) * 1.2 + c.u * 2, ry = (r.h / 2) * 1.2 + c.u * 2;
			const n = 14, from = (-150 * Math.PI) / 180, sweep = ((360 + 25) * Math.PI) / 180;
			const pts = Array.from({ length: n }, (_, i): [number, number] => {
				const t = from + (sweep * i) / (n - 1);
				return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
			});
			const extent = grow({ x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry }, c.u);
			return { kind: "circle", pts, extent, note: label(extent) };
		}
		case "underline": {
			const y = r.y + r.h + c.u;
			const pts = [0, 1 / 3, 2 / 3, 1].map((t): [number, number] => [r.x + r.w * t, y]);
			const extent = grow({ x: r.x, y: y, w: r.w, h: 0 }, c.u);
			return { kind: "underline", pts, extent, note: label(extent) };
		}
		case "check": {
			const extent = grow({ x: r.x + r.w - g, y: r.y - g * 0.7, w: g * 1.3, h: g * 1.1 }, c.u);
			return { kind: "check", r, g, extent, note: label(extent) };
		}
		case "cross": {
			const extent = grow({ x: r.x + r.w - g * 0.5, y: r.y - g * 0.5, w: g, h: g }, c.u);
			return { kind: "cross", r, g, extent, note: label(extent) };
		}
		case "note":
			// A free note stands off the target's top-right corner.
			return { kind: "note", extent: null, note: { markBox: r, prefer: "above-right", text: mark.label ?? "note" } };
	}
}

/** One mark laid out: its geometry, its colour and its placed note. */
interface LaidMark {
	geo: MarkGeometry;
	color: string;
	note: PlacedNoteInk | null;
}

/**
 * Every mark's geometry and every note's spot, in mark order (null for a mark that no longer resolves). The
 * obstacles are each mark's drawn extent and the learner's typed objects (text, markdown, LaTeX, table and
 * image boxes); freehand strokes and shapes are not. `sides` fixes each mark's note side (stable spots).
 */
function layoutInk(marks: readonly AnnotationMark[], scene: DrawingScene, box: Box, c: Ctx, sides?: readonly (Side | undefined)[]): Array<LaidMark | null> {
	const geos = marks.map((m) => markGeometry(m, scene, box, c));
	const obstacles = [...geos.flatMap((g) => (g?.extent ? [g.extent] : [])), ...scene.objects.filter(isTypedObject).map((o) => toSpace(o, c))];
	const lh = c.fs * 1.2, m = c.fs * NOTE_HALO_EM;
	const asked = geos.flatMap((g, i) => {
		if (!g?.note) return [];
		const lines = noteLines(g.note.text);
		return [{ i, anchor: g.note, lines, w: Math.max(...lines.map((l) => l.length), 2) * c.fs * NOTE_CHAR_EM + 2 * m, h: lines.length * lh + 2 * m }];
	});
	const placed = layoutNotes(
		asked.map((a) => ({ markBox: a.anchor.markBox, w: a.w, h: a.h, prefer: a.anchor.prefer })),
		obstacles,
		c.fs * NOTE_GAP_EM,
		asked.map((a) => sides?.[a.i]),
	);
	const notes = new Map(
		asked.map((a, j) => {
			const p = placed[j]!;
			return [a.i, { box: p.box, side: p.side, lines: a.lines, text: a.anchor.text, leader: p.leader ? leaderLine(p.box, a.anchor.markBox) : null }] as const;
		}),
	);
	return geos.map((geo, i) => (geo ? { geo, color: marks[i]!.kind === "check" ? c.green : c.red, note: notes.get(i) ?? null } : null));
}

function Mark({ laid: { geo, color, note: placed }, seed, c }: { laid: LaidMark; seed: number; c: Ctx }) {
	const sw = f(c.u);
	const common = { fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
	const note = placed ? <HandNote note={placed} color={color} c={c} /> : null;
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

function inkContext(box: Box, space: "world" | "percent", theme: "light" | "dark", zoom?: number): Ctx {
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
		fs: noteSize(worldUnit * k, percent, box.w * k, box.h * k, zoom),
	};
}

/** Pure: the world-space boxes the marks cover as drawn in the workspace at `zoom` (with the note `sides`
 *  TeacherInk is given), each mark's extent and its placed note's box (the same layout TeacherInk draws), in
 *  mark order; a mark that no longer resolves gives none. */
export function teacherInkBoxes(marks: readonly AnnotationMark[], scene: DrawingScene, box: Box, zoom?: number, sides?: readonly (Side | undefined)[]): Box[] {
	const c = inkContext(box, "world", "dark", zoom);
	return layoutInk(marks, scene, box, c, sides).flatMap((l) => (l ? [...(l.geo.extent ? [l.geo.extent] : []), ...(l.note ? [l.note.box] : [])] : []));
}

/** Pure: the side each mark's note takes when laid out freely in the workspace at `zoom` (undefined for a mark
 *  without a note or that no longer resolves). The workspace solves this once per marking turn, at the zoom
 *  after the reveal, and passes it back as TeacherInk's `sides`, so notes never jump while he zooms. */
export function teacherNoteSides(marks: readonly AnnotationMark[], scene: DrawingScene, box: Box, zoom?: number): Array<Side | undefined> {
	return layoutInk(marks, scene, box, inkContext(box, "world", "dark", zoom)).map((l) => l?.note?.side);
}

/** The drawing and the thumbnail's paper in percent space: the drawing is `0 0 100 h`, and the paper (the
 *  svg's view box) grows round it to hold every mark and note. Only the paper grows, never the grid box. */
export function teacherInkView(marks: readonly AnnotationMark[], scene: DrawingScene, box: Box): { drawing: Box; view: Box } {
	const c = inkContext(box, "percent", "light");
	return paperOf(layoutInk(marks, scene, box, c), box, c);
}

/** The paper: the drawing grown to every mark and note, plus a small margin on each side it grew, so a note's
 *  first letter never sits on the thumbnail's border. */
function paperOf(laid: ReadonlyArray<LaidMark | null>, box: Box, c: Ctx): { drawing: Box; view: Box } {
	const drawing = { x: 0, y: 0, w: 100, h: (100 * Math.max(box.h, 1)) / Math.max(box.w, 1) };
	const u = laid.reduce<R>((v, l) => [l?.geo.extent, l?.note?.box].reduce<R>((a, b) => (b ? union(a, b) : a), v), drawing);
	const pad = c.fs * NOTE_HALO_EM;
	const x0 = u.x < 0 ? u.x - pad : 0, y0 = u.y < 0 ? u.y - pad : 0;
	const x1 = u.x + u.w > drawing.w ? u.x + u.w + pad : drawing.w, y1 = u.y + u.h > drawing.h ? u.y + u.h + pad : drawing.h;
	return { drawing, view: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** A view box rounded outward to 2 decimals, so nothing at its edge is clipped. */
function viewBoxOf(v: Box): string {
	const x = Math.floor(v.x * 100) / 100, y = Math.floor(v.y * 100) / 100;
	return `${x} ${y} ${f(Math.ceil((v.x + v.w) * 100) / 100 - x)} ${f(Math.ceil((v.y + v.h) * 100) / 100 - y)}`;
}

export function TeacherInk({ marks, scene, box, space, theme = "dark", zoom, sides }: TeacherInkProps) {
	const percent = space === "percent";
	const c = inkContext(box, space, theme, percent ? undefined : zoom);
	const laid = layoutInk(marks, scene, box, c, percent ? undefined : sides);
	const body = (
		<g data-testid="teacher-ink">
			{marks.map((m, i) => {
				const l = laid[i];
				return l ? <Mark key={i} laid={l} seed={hashString(JSON.stringify(m)) + i} c={c} /> : null;
			})}
		</g>
	);
	if (!percent) return body;
	return (
		<svg viewBox={viewBoxOf(paperOf(laid, box, c).view)} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
			{body}
		</svg>
	);
}
