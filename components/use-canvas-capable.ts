"use client";

import { useSyncExternalStore } from "react";

/** The canvas needs a real drawing surface: the PHYSICAL screen (not the
 *  viewport, so an iPad in split view still counts) must be at least 600 css
 *  px on its short side. Pure: the screen is passed in. */
export function isCanvasCapable(screen: { width: number; height: number } | undefined): boolean {
	if (!screen) return false;
	return Math.min(screen.width, screen.height) >= 600;
}

const subscribe = (): (() => void) => () => {};

/** True on a tablet or computer. The server snapshot is false, so SSR and
 *  the first client render agree (a phone never flashes a Canvas pill). */
export function useCanvasCapable(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => isCanvasCapable(typeof window === "undefined" ? undefined : window.screen),
		() => false,
	);
}
