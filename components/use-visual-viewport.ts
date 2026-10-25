"use client";

import { useEffect, useState } from "react";
import { isKeyboardOpen } from "@/components/sidebar-state";

/** The height to size the app to while the on-screen keyboard is up, or null
 *  when it is not (the layout then keeps its normal `dvh` sizing). iOS Safari
 *  shrinks only the visual viewport for the keyboard, never `dvh`. */
export function keyboardViewportHeight(visualHeight: number, layoutHeight: number, coarse: boolean): number | null {
	return isKeyboardOpen(visualHeight, layoutHeight, coarse) ? Math.round(visualHeight) : null;
}

/** Track `window.visualViewport`: publishes `--vvh` (visible height in px) on
 *  <html> while the keyboard is open and removes it otherwise, and returns the
 *  "keyboard open" flag. Layout reads it as `var(--vvh, <normal height>)`. */
export function useVisualViewport(): boolean {
	const [keyboard, setKeyboard] = useState(false);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const coarse = window.matchMedia("(pointer: coarse)");
		const root = document.documentElement;
		const update = () => {
			const h = keyboardViewportHeight(vv.height, window.innerHeight, coarse.matches);
			if (h === null) root.style.removeProperty("--vvh");
			else root.style.setProperty("--vvh", `${h}px`);
			setKeyboard(h !== null);
		};
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
			root.style.removeProperty("--vvh");
		};
	}, []);
	return keyboard;
}
