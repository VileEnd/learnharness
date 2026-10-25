/**
 * Shared pan/zoom viewport math — the "fit floor" semantics harvested from
 * the plan popup (plan-graph rounds 2–4) so the session overlays (the plan
 * focus, the mermaid focus) run the SAME geometry: fully zoomed out IS the
 * fit (whichever axis binds), panning locks at the floor (nothing to move),
 * wheel zooms to the cursor. Pure on purpose: the overlays are render-tested
 * in static markup (no live pointer events), so the math lives here where
 * tests can pin it (tests/pan-zoom.test.ts).
 */

/** Zoom ceiling for every surface that uses this math (raised 2×→4× for
 *  reading node titles closely, owner, plan-graph round 3). */
export const ZOOM_MAX = 4;
/** Viewport breathing room subtracted by the fit. */
export const FIT_PAD = 16;
/** The fit never zooms IN past this — a tiny diagram must not blow up. */
export const FIT_ZOOM_MAX = 1.5;

/** A pan/zoom viewport state (translate + scale; origin top-left). */
export interface Viewport {
	zoom: number;
	x: number;
	y: number;
}

/** The fit zoom for a box in a viewport: never below a true fit (the old
 *  0.15 floor could sit ABOVE the fit for wide graphs — the epsilon only
 *  guards degenerate viewports), never above FIT_ZOOM_MAX. Pure. */
export function fitZoomFor(box: { w: number; h: number }, viewport: { w: number; h: number }): number {
	if (!viewport.w || !viewport.h || box.w === 0) return 1;
	return Math.max(0.02, Math.min((viewport.w - FIT_PAD) / box.w, (viewport.h - FIT_PAD) / box.h, FIT_ZOOM_MAX));
}

/** Centers a box (at the given zoom) in the viewport. Pure. */
export function fitGraphView(box: { w: number; h: number }, viewport: { w: number; h: number }, zoom: number): Viewport {
	return { zoom, x: (viewport.w - box.w * zoom) / 2, y: (viewport.h - box.h * zoom) / 2 };
}

/** Zoom by `factor` keeping `focus` (viewport coordinates) visually fixed,
 *  clamped to [floor, ZOOM_MAX]. At the floor the view re-fits + RE-CENTERS
 *  (the fit IS the floor — a locked view there has nothing to move). Pure. */
export function zoomedGraphView(
	view: Viewport,
	factor: number,
	floor: number,
	focus: { x: number; y: number },
	box: { w: number; h: number },
	viewport: { w: number; h: number },
): Viewport {
	const zoom = Math.min(Math.max(view.zoom * factor, floor), ZOOM_MAX);
	if (zoom === view.zoom) return view;
	if (zoom <= floor) return fitGraphView(box, viewport, floor);
	const k = zoom / view.zoom;
	return { zoom, x: focus.x - (focus.x - view.x) * k, y: focus.y - (focus.y - view.y) * k };
}

/** A point in viewport coordinates. */
export interface Pt {
	x: number;
	y: number;
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Two-finger pinch: zoom by the ratio of the finger distances around the
 *  previous midpoint (so the content under the fingers stays under them),
 *  then follow the midpoint's own movement as a pan. Same fit-floor and
 *  ZOOM_MAX clamps as every other zoom; at the floor the view re-fits, so
 *  nothing pans there. Pure. */
export function pinchView(
	view: Viewport,
	prev: readonly [Pt, Pt],
	next: readonly [Pt, Pt],
	floor: number,
	box: { w: number; h: number },
	viewport: { w: number; h: number },
): Viewport {
	const d0 = Math.hypot(prev[0].x - prev[1].x, prev[0].y - prev[1].y);
	const d1 = Math.hypot(next[0].x - next[1].x, next[0].y - next[1].y);
	if (d0 < 1) return view;
	const m0 = mid(prev[0], prev[1]);
	const m1 = mid(next[0], next[1]);
	const zoomed = zoomedGraphView(view, d1 / d0, floor, m0, box, viewport);
	if (zoomed.zoom <= floor + 1e-9) return zoomed;
	return { ...zoomed, x: zoomed.x + (m1.x - m0.x), y: zoomed.y + (m1.y - m0.y) };
}
