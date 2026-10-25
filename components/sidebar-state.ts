/**
 * Pure decisions behind the phone drawer (kept out of sidebar.tsx so the
 * tests need no DOM): where the open state lives, what it defaults to, and
 * which touch drags open or close the drawer.
 */

/** Tailwind's `md` — at and above it the sidebar is the inline push panel. */
export const WIDE_QUERY = "(min-width: 768px)";

const WIDE_KEY = "lh:sidebar-open";
const NARROW_KEY = "lh:sidebar-open-narrow";

/** Phone and desktop keep separate stored states so they never fight. */
export function sidebarStorageKey(wide: boolean): string {
	return wide ? WIDE_KEY : NARROW_KEY;
}

/** Wide screens restore the stored state (default open: the first run
 *  introduces the sidebar). On a phone the drawer covers the whole app, so
 *  every page load starts with it closed. */
export function resolveSidebarOpen(stored: string | null, wide: boolean): boolean {
	if (!wide) return false;
	return stored === null ? true : stored === "1";
}

/** The on-screen keyboard is up when the visible viewport has lost a big
 *  share of the layout viewport (touch devices only — a small desktop
 *  window is not a keyboard). */
export function isKeyboardOpen(visualHeight: number, layoutHeight: number, coarse: boolean): boolean {
	return coarse && visualHeight < layoutHeight * 0.75;
}

const EDGE_PX = 20; // a drag that starts this close to the left edge opens
const MIN_DX = 60; // horizontal travel that counts as a swipe
const MAX_SLOPE = 0.6; // |dy| / |dx| — mostly horizontal, not a scroll

/** Classify one finished touch: swipe right from the left edge opens a
 *  closed drawer; swipe left anywhere closes an open one. */
export function classifySwipe(
	start: { x: number; y: number },
	end: { x: number; y: number },
	open: boolean,
): "open" | "close" | null {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (Math.abs(dy) > Math.abs(dx) * MAX_SLOPE) return null;
	if (!open && start.x < EDGE_PX && dx > MIN_DX) return "open";
	if (open && dx < -MIN_DX) return "close";
	return null;
}
