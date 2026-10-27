/**
 * TEACHER INK (PR 3): the marks the agent drew with `annotate`, rendered over a drawing.
 * Marks are anchored (object id / grid cell / range), so each is resolved to a world rectangle against the
 * scene and the grid box (`resolveTargetRect`); a mark that no longer resolves is skipped.
 *
 * - space "world": a `<g>` in world coordinates, to sit inside an svg carrying the viewport transform.
 * - space "percent": a standalone `<svg>` laid over a thumbnail of the scene box; units are percent of
 *   the box width on both axes (viewBox 0 0 100 100*h/w), so glyphs keep their proportions.
 * Colours go through the palette helper (TEACHER_INK_COLOR); the thumbnail PNG is always light.
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
	color: string;
	/** Badge background: the opposite-theme ink, so text stays legible on any ground. */
	paper: string;
	/** Horizontal extent of the drawing in space coordinates; badges are kept inside it. */
	minX: number;
	maxX: number;
}

type R = { x: number; y: number; w: number; h: number };
const f = (n: number) => Math.round(n * 100) / 100;

function rectOf(target: AnnotationTarget | undefined, scene: DrawingScene, box: Box, c: Ctx): R | null {
	if (!target) return null;
	const r = resolveTargetRect(target, scene, box);
	return r ? { x: (r.x - c.ox) * c.k, y: (r.y - c.oy) * c.k, w: r.w * c.k, h: r.h * c.k } : null;
}

const BADGE_CHARS = 26;

function Badge({ x: x0, y, text: full, c }: { x: number; y: number; text: string; c: Ctx }) {
	const fs = c.u * 2.6;
	// A long caption is cut for the badge (the full text stays in the tooltip and the AnnotateCard).
	const text = full.length > BADGE_CHARS ? `${full.slice(0, BADGE_CHARS - 1)}\u2026` : full;
	const w = Math.max(fs * 2, text.length * fs * 0.58 + fs);
	const h = fs * 1.6;
	const x = Math.max(c.minX, Math.min(x0, c.maxX - w));
	return (
		<g>
			<title>{full}</title>
			<rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(h / 2)} fill={c.paper} stroke={c.color} strokeWidth={f(c.u * 0.6)} />
			<text x={f(x + w / 2)} y={f(y + h / 2)} fontSize={f(fs)} fill={c.color} textAnchor="middle" dominantBaseline="central" fontFamily="sans-serif" fontWeight={600}>
				{text}
			</text>
		</g>
	);
}

function Mark({ mark, scene, box, c }: { mark: AnnotationMark; scene: DrawingScene; box: Box; c: Ctx }) {
	const sw = f(c.u);
	const common = { fill: "none", stroke: c.color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
	if (mark.kind === "arrow") {
		const a = rectOf(mark.from, scene, box, c);
		const b = rectOf(mark.to, scene, box, c);
		if (!a || !b) return null;
		const x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
		const ang = Math.atan2(y2 - y1, x2 - x1);
		const hl = c.u * 4;
		const head = [-0.45, 0.45].map((d) => `${f(x2 - hl * Math.cos(ang + d))},${f(y2 - hl * Math.sin(ang + d))}`);
		return (
			<g data-mark="arrow">
				<line x1={f(x1)} y1={f(y1)} x2={f(x2)} y2={f(y2)} {...common} />
				<polyline points={`${head[0]} ${f(x2)},${f(y2)} ${head[1]}`} {...common} />
				{mark.label ? <Badge x={(x1 + x2) / 2} y={(y1 + y2) / 2} text={mark.label} c={c} /> : null}
			</g>
		);
	}
	const r = rectOf(mark.target, scene, box, c);
	if (!r) return null;
	const g = c.u * 4; // glyph size
	const label = mark.label ? <Badge x={mark.kind === "note" ? r.x + r.w : r.x} y={mark.kind === "note" ? r.y - g : r.y + r.h + c.u} text={mark.label} c={c} /> : null;
	switch (mark.kind) {
		case "circle":
			return (
				<g data-mark="circle">
					<ellipse cx={f(r.x + r.w / 2)} cy={f(r.y + r.h / 2)} rx={f((r.w / 2) * 1.2 + c.u * 2)} ry={f((r.h / 2) * 1.2 + c.u * 2)} {...common} />
					{label}
				</g>
			);
		case "underline":
			return (
				<g data-mark="underline">
					<line x1={f(r.x)} y1={f(r.y + r.h + c.u)} x2={f(r.x + r.w)} y2={f(r.y + r.h + c.u)} {...common} />
					{label}
				</g>
			);
		case "check":
			return (
				<g data-mark="check">
					<polyline points={`${f(r.x + r.w - g)},${f(r.y - g * 0.1)} ${f(r.x + r.w - g * 0.6)},${f(r.y + g * 0.4)} ${f(r.x + r.w + g * 0.3)},${f(r.y - g * 0.7)}`} {...common} strokeWidth={f(c.u * 1.3)} />
					{label}
				</g>
			);
		case "cross":
			return (
				<g data-mark="cross">
					<path d={`M${f(r.x + r.w - g * 0.5)} ${f(r.y - g * 0.5)}L${f(r.x + r.w + g * 0.5)} ${f(r.y + g * 0.5)}M${f(r.x + r.w + g * 0.5)} ${f(r.y - g * 0.5)}L${f(r.x + r.w - g * 0.5)} ${f(r.y + g * 0.5)}`} {...common} strokeWidth={f(c.u * 1.3)} />
					{label}
				</g>
			);
		case "note":
			return (
				<g data-mark="note">
					<Badge x={r.x + r.w} y={r.y - g} text={mark.label ?? "note"} c={c} />
				</g>
			);
	}
}

export function TeacherInk({ marks, scene, box, space, theme = "dark" }: TeacherInkProps) {
	const percent = space === "percent";
	const k = percent ? 100 / Math.max(box.w, 1) : 1;
	// Base unit: 3 world px, but never thinner than 1/120 of the box width (so a thumbnail still shows it).
	const worldUnit = Math.max(3, box.w / 120);
	const c: Ctx = { k, ox: percent ? box.x : 0, oy: percent ? box.y : 0, u: worldUnit * k, color: screenColor(TEACHER_INK_COLOR, theme), paper: screenColor("ink", theme === "dark" ? "light" : "dark"), minX: (box.x - (percent ? box.x : 0)) * k, maxX: (box.x + box.w - (percent ? box.x : 0)) * k };
	const body = (
		<g data-testid="teacher-ink">
			{marks.map((m, i) => (
				<Mark key={i} mark={m} scene={scene} box={box} c={c} />
			))}
		</g>
	);
	if (!percent) return body;
	return (
		<svg viewBox={`0 0 100 ${f((100 * Math.max(box.h, 1)) / Math.max(box.w, 1))}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
			{body}
		</svg>
	);
}
