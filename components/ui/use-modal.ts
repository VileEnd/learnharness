"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * ONE MODAL BEHAVIOUR for every surface that declares `aria-modal`. While the
 * hosting component is mounted (every modal here is mounted only while open):
 *
 *   - focus moves inside: to the element marked `data-autofocus` (the cancel
 *     of a confirm; or the surface itself, when it carries the mark), else the
 *     first tabbable control, else the surface itself; an element inside that
 *     already took focus (an `autoFocus` input) wins. The surface takes focus
 *     where the first control is a tooltip trigger (it would pop its tooltip
 *     on every open); the first Tab then reaches that control;
 *   - Tab and Shift+Tab cycle inside the surface. They are claimed at the
 *     document level (the one-Esc law's layer) and moved by hand: the global
 *     Tab handler in keyboard-shortcuts.tsx suppresses native Tab on every
 *     page, and Shift+Tab there cycles the thinking level, which must not
 *     happen behind a modal;
 *   - everything else in the app is `inert` (the siblings of the surface and
 *     of each of its ancestors, up to <body>). Counted per element, so with
 *     several modals open the page stays inert until the LAST one closes.
 *     A surface mounted inside the session area (plan popup, diagram focus,
 *     canvas workspace) passes `"session"`: by the owner's design those do
 *     not cover the app chrome, so only its siblings inside that area go
 *     inert and the sidebar and top bar stay live;
 *   - on close, focus returns to the element that had it at open, if it is
 *     still in the document. Where the app blurred the opener on a pointer
 *     click (focus-hygiene.ts), the control last pressed stands in for it.
 *     When the opener has unmounted (a menu item), the controls pressed
 *     before it are tried newest first (the menu's trigger), then the main
 *     region: never <body>. A modal closed out of order hands the opener of
 *     the ones above it on, so focus never lands behind a modal that remains.
 *   - only the topmost surface may act on Escape: `isTopModal(root)`.
 *
 * Hand-written rather than radix FocusScope: the manual Tab handling above is
 * needed anyway, and FocusScope neither makes the page inert nor counts
 * stacked surfaces. Escape, the backdrop and the back gesture stay with each
 * surface (they differ: some are guarded while busy).
 */

const FOCUSABLE =
	'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable=""], [contenteditable="true"], [tabindex]';

/** Never made inert: not interactive, or the framework's announcer / dev overlay. */
const NEVER_INERT = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT", "NEXT-ROUTE-ANNOUNCER", "NEXTJS-PORTAL"]);

/** The tabbable controls inside `root`, in document order. */
export function tabbablesIn(root: Element): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
		// A `tabindex` qualifies any element, a disabled control included.
		if (el.hasAttribute("disabled") || el.closest("fieldset[disabled]")) return false;
		if (Number.parseInt(el.getAttribute("tabindex") ?? "0", 10) < 0) return false;
		if (el.closest("[inert], [hidden]")) return false;
		// Layout-less environments (no getClientRects) count everything as shown.
		if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) return false;
		return true;
	});
}

/** Pure: the control Tab (or Shift+Tab with `backwards`) lands on, wrapping
 *  at both ends. `current` need not be in the list (a container, a button
 *  that just got disabled): then the next/previous one in document order. */
export function nextTabTarget<T extends Element>(items: T[], current: Element | null, backwards: boolean): T | null {
	if (items.length === 0) return null;
	const at = current ? items.indexOf(current as T) : -1;
	if (at >= 0) return items[(at + (backwards ? -1 : 1) + items.length) % items.length] ?? null;
	if (current && typeof current.compareDocumentPosition === "function") {
		const FOLLOWING = 4;
		const PRECEDING = 2;
		const wanted = backwards ? PRECEDING : FOLLOWING;
		const pool = backwards ? [...items].reverse() : items;
		const found = pool.find((item) => current.compareDocumentPosition(item) & wanted);
		if (found) return found;
	}
	return backwards ? (items[items.length - 1] ?? null) : (items[0] ?? null);
}

/** The controls the user pressed lately, newest last: the stand-in opener
 *  when the app blurred the control before the surface mounted, and the way
 *  back to a menu's trigger once the menu item that opened the surface is gone. */
const PRESSABLE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [tabindex]';
const pressed: { el: Element; at: number }[] = [];
/** A pointer press this recent stands in for a blurred opener (ms). */
const RECENT_PRESS_MS = 1500;
let tracking = false;

function notePress(e: Event) {
	if (e.type === "keydown" && (e as KeyboardEvent).key !== "Enter" && (e as KeyboardEvent).key !== " ") return;
	const t = e.target;
	if (!(t instanceof Element)) return;
	const el = t.closest(PRESSABLE) ?? t;
	if (el === document.body || el === document.documentElement) return;
	const at = pressed.findIndex((p) => p.el === el);
	if (at >= 0) pressed.splice(at, 1);
	pressed.push({ el, at: Date.now() });
	if (pressed.length > 8) pressed.shift();
}

function track() {
	if (tracking || typeof document === "undefined") return;
	tracking = true;
	document.addEventListener("pointerdown", notePress, true);
	document.addEventListener("keydown", notePress, true);
}
track();

/** The element that "opened" a surface now mounting. */
function currentOpener(): Element | null {
	track();
	const active = document.activeElement;
	if (active && active !== document.body && active !== document.documentElement) return active;
	const last = pressed[pressed.length - 1];
	return last && last.el.isConnected && Date.now() - last.at < RECENT_PRESS_MS ? last.el : null;
}

interface Entry {
	root: HTMLElement;
	/** Where focus goes back to on close (null: nowhere). */
	opener: Element | null;
	/** The elements this modal marked inert (counted in `held`). */
	held: Element[];
}

const stack: Entry[] = []; // open modals, bottom first
const held = new Map<Element, { count: number; own: boolean }>(); // inert bookkeeping

/** Everything outside `root`: its siblings, and its ancestors' siblings, up to <body>. */
function outsiders(root: Element): Element[] {
	const out: Element[] = [];
	for (let node: Element | null = root; node && node !== document.body; node = node.parentElement) {
		for (const sibling of Array.from(node.parentElement?.children ?? [])) {
			if (sibling !== node && !NEVER_INERT.has(sibling.tagName)) out.push(sibling);
		}
	}
	return out;
}

function hold(el: Element) {
	const state = held.get(el);
	if (state) state.count++;
	else {
		const own = !el.hasAttribute("inert");
		if (own) el.setAttribute("inert", "");
		held.set(el, { count: 1, own });
	}
}

function release(el: Element) {
	const state = held.get(el);
	if (!state) return;
	if (--state.count > 0) return;
	held.delete(el);
	if (state.own) el.removeAttribute("inert");
}

function focusInitial(root: HTMLElement) {
	const active = document.activeElement;
	if (active && active !== document.body && root.contains(active)) return;
	const target = root.hasAttribute("data-autofocus") ? null : (root.querySelector<HTMLElement>("[data-autofocus]") ?? tabbablesIn(root)[0]);
	if (target) target.focus();
	else {
		if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
		root.focus();
	}
}

function onKeyDown(e: KeyboardEvent) {
	if (e.key !== "Tab" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
	const top = stack[stack.length - 1];
	if (!top) return;
	const target = e.target instanceof Element ? e.target : null;
	// Focus outside the surface but live (a menu or popover opened from it):
	// that layer's own keys apply. Focus on <body> or in an inert region is
	// lost focus: pull it back in.
	if (target && !top.root.contains(target) && target !== document.body && target !== document.documentElement && !target.closest("[inert]")) return;
	e.preventDefault();
	e.stopPropagation();
	const items = tabbablesIn(top.root);
	// A candidate that refuses focus (the page changed under us) must not
	// stall the trap: try the one after it, at most once around.
	let candidate = nextTabTarget(items, target && top.root.contains(target) ? target : null, e.shiftKey);
	for (let tries = 0; candidate && tries < items.length; tries++) {
		candidate.focus();
		if (document.activeElement === candidate) return;
		candidate = nextTabTarget(items, candidate, e.shiftKey);
	}
	if (!top.root.hasAttribute("tabindex")) top.root.setAttribute("tabindex", "-1");
	top.root.focus();
}

/** Where the inert reaches: the whole app, or only the area the surface sits in. */
export type ModalScope = "app" | "session";

function open(root: HTMLElement, opener: Element | null, scope: ModalScope): Entry {
	const held = scope === "session" ? Array.from(root.parentElement?.children ?? []).filter((el) => el !== root && !NEVER_INERT.has(el.tagName)) : outsiders(root);
	const entry: Entry = { root, opener, held };
	if (stack.length === 0) document.addEventListener("keydown", onKeyDown);
	stack.push(entry);
	for (const el of entry.held) hold(el);
	focusInitial(root);
	return entry;
}

function close(entry: Entry) {
	const at = stack.indexOf(entry);
	if (at < 0) return;
	stack.splice(at, 1);
	for (const el of entry.held) release(el);
	if (stack.length === 0) document.removeEventListener("keydown", onKeyDown);
	if (at < stack.length) {
		// Closed from underneath: surfaces above that were opened from inside
		// this one inherit its opener (theirs is about to disappear).
		for (const above of stack.slice(at)) {
			if (above.opener && entry.root.contains(above.opener)) above.opener = entry.opener;
		}
		return;
	}
	restoreFocus(entry.opener);
}

function focusIfPossible(el: Element | null): boolean {
	if (!el || el === document.body || !(el instanceof HTMLElement) || !document.contains(el)) return false;
	el.focus();
	return document.activeElement === el;
}

function restoreFocus(opener: Element | null) {
	if (focusIfPossible(opener)) return;
	// Only when there WAS an opener that is gone (its menu closed): the
	// control pressed before it, newest first.
	if (opener) {
		for (let i = pressed.length - 1; i >= 0; i--) {
			const el = pressed[i]!.el;
			if (el !== opener && focusIfPossible(el)) return;
		}
	}
	const main = document.querySelector<HTMLElement>('main, [role="main"]');
	if (!main) return;
	if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
	main.focus();
}

/** The topmost open surface's root (null: none open). */
export function topModalRoot(): HTMLElement | null {
	return stack[stack.length - 1]?.root ?? null;
}

/** May the surface rooted at `root` act on Escape? Only the topmost may;
 *  with nothing registered (not yet mounted) it may. */
export function isTopModal(root: Element | null | undefined): boolean {
	const top = stack[stack.length - 1];
	return !top || top.root === root;
}

/** Make the surface in `ref` modal while `active` (default: as long as the
 *  calling component is mounted, which is how most surfaces here work; pass
 *  `open` for one that stays mounted and renders null when closed). Call it
 *  from the component that renders the surface's root. */
export function useModal(ref: RefObject<HTMLElement | null>, active = true, scope: ModalScope = "app"): void {
	// Captured while rendering, before an `autoFocus` inside can steal focus.
	const opener = useRef<Element | null | undefined>(undefined);
	if (!active) opener.current = undefined;
	else if (opener.current === undefined) opener.current = typeof document === "undefined" ? null : currentOpener();
	useEffect(() => {
		const root = ref.current;
		if (!active || !root) return;
		const entry = open(root, opener.current ?? null, scope);
		return () => close(entry);
	}, [ref, active, scope]);
}
