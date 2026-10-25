"use client";

import { useEffect, useRef } from "react";

/**
 * BACK GESTURE CLOSES OVERLAYS (Android back / iOS edge swipe). An open
 * overlay or dialog pushes one history entry; popping it (the gesture)
 * dismisses the overlay instead of leaving the page. Closing it any other
 * way pops its entry again so the history stays clean.
 *
 * One module-level mirror of the entries we pushed, plus the set of overlays
 * still open, keeps the whole thing consistent when overlays nest or close
 * out of order. The entry's state spreads `history.state` so Next's router
 * keeps recognising it as one of its own entries.
 */

/** Pure: after a popstate to the entry tagged `current` (null = an entry we
 *  did not push), which of our entries are gone? `popped` is top-first. An
 *  unknown tag (forward navigation) changes nothing. */
export function popEntries(entries: number[], current: number | null): { entries: number[]; popped: number[] } {
	if (current === null) return { entries: [], popped: [...entries].reverse() };
	const at = entries.lastIndexOf(current);
	if (at < 0) return { entries, popped: [] };
	return { entries: entries.slice(0, at + 1), popped: entries.slice(at + 1).reverse() };
}

const live = new Map<number, () => void>(); // open overlays: id -> dismiss
let entries: number[] = []; // history entries we pushed, bottom-first
let nextId = 1;
let listening = false;

function currentTag(): number | null {
	const tag = (window.history.state as { lhBack?: unknown } | null)?.lhBack;
	return typeof tag === "number" ? tag : null;
}

function onPop(): void {
	const r = popEntries(entries, currentTag());
	entries = r.entries;
	for (const id of r.popped) {
		const dismiss = live.get(id);
		if (!dismiss) continue; // closed normally earlier — nothing to do
		live.delete(id);
		dismiss();
	}
}

function register(dismiss: () => void): number {
	if (!listening) {
		window.addEventListener("popstate", onPop);
		listening = true;
	}
	const id = nextId++;
	live.set(id, dismiss);
	entries.push(id);
	window.history.pushState({ ...(window.history.state as object | null), lhBack: id }, "");
	return id;
}

function release(id: number): void {
	if (!live.delete(id)) return; // the back gesture already closed it
	// Deferred a tick: a StrictMode remount re-registers synchronously, and
	// a back() issued here would land after that new push and close it.
	setTimeout(() => {
		// Pop our entry only while it is still the current one; after the
		// user (or Next) navigated on, going back would undo that navigation.
		if (entries.at(-1) === id && currentTag() === id) {
			entries.pop();
			window.history.back();
		}
	}, 0);
}

/** While `open`, the back gesture calls `onDismiss` (which should close it). */
export function useBackDismiss(open: boolean, onDismiss: () => void): void {
	const ref = useRef(onDismiss);
	ref.current = onDismiss;
	useEffect(() => {
		if (!open) return;
		const id = register(() => ref.current());
		return () => release(id);
	}, [open]);
}
