"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

function subscribe(onChange: () => void): () => void {
	const mq = window.matchMedia(QUERY);
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}

/** True on a touch-first device (phone/tablet). The server snapshot is false,
 *  so SSR and the first client render match the desktop markup. */
export function useCoarsePointer(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(QUERY).matches,
		() => false,
	);
}

/** Grow a textarea to its content where CSS `field-sizing: content` is
 *  missing (older Safari/Firefox). A no-op where the CSS does the work; the
 *  min-/max-height classes on the field still clamp the measured height. */
export function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
	const supported = useRef<boolean | null>(null);
	useEffect(() => {
		if (supported.current === null) supported.current = CSS.supports("field-sizing", "content");
		const el = ref.current;
		if (!el || supported.current) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [ref, value]);
}
