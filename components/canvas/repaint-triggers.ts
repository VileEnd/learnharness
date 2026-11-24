/**
 * Events that leave a canvas bitmap stale while the scene is unchanged, so the
 * engine must repaint without an edit:
 *  - `contextrestored`: the browser discarded a 2D context (memory pressure, a
 *    backgrounded tab on a phone) and gave back a blank one. The event doesn't
 *    bubble, so it is heard on each canvas. `contextlost` is deliberately not
 *    cancelled: for a 2D context that would stop the browser restoring it.
 *  - a devicePixelRatio change with no box change (the window moves to another
 *    screen, some zoom paths): a ResizeObserver never fires, and the ink stays
 *    blurry. A `(resolution: Ndppx)` query fires once when the ratio leaves N,
 *    so it is re-armed with the new ratio every time.
 */

export type MediaQueryLike = Pick<MediaQueryList, "addEventListener" | "removeEventListener">;

export type RepaintEnv = {
	dpr: () => number;
	matchMedia?: (query: string) => MediaQueryLike;
};

/** Calls `onContextRestored` when either canvas gets its context back and
 *  `onDensityChange` when devicePixelRatio changes; returns the disposer. */
export function watchRepaintTriggers(
	canvases: readonly EventTarget[],
	env: RepaintEnv,
	onContextRestored: () => void,
	onDensityChange: () => void,
): () => void {
	const restored = () => onContextRestored();
	for (const c of canvases) c.addEventListener("contextrestored", restored);

	let disarm: (() => void) | null = null;
	let disposed = false;
	const arm = () => {
		if (disposed || !env.matchMedia) return;
		const mql = env.matchMedia(`(resolution: ${env.dpr()}dppx)`);
		const changed = () => {
			disarm = null;
			onDensityChange();
			arm();
		};
		mql.addEventListener("change", changed, { once: true });
		disarm = () => mql.removeEventListener("change", changed);
	};
	arm();

	return () => {
		disposed = true;
		for (const c of canvases) c.removeEventListener("contextrestored", restored);
		disarm?.();
		disarm = null;
	};
}
