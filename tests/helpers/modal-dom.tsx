/**
 * linkedom with the two things the modal tests need that it lacks: a focus
 * model (focus(), document.activeElement) that behaves like a browser for
 * inert, disabled and removed elements, and keydown dispatch. The model is
 * this file's assumption about browsers (HTML "focusable area" rules: a bare
 * div refuses focus(), disabled and inert elements too); real
 * focus, inert and Tab order are not verified here.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

export const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
Object.assign(dom.window, { getSelection: () => ({ rangeCount: 0, anchorNode: null }) });

// linkedom lacks the `input` event, so React falls back to its IE path for
// focused text fields (focusin -> attachEvent): inert stand-ins.
Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });

let active: Element | null = null;
/** Like a browser: only these take focus (a bare div does not; one with a tabindex does). */
const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
dom.window.HTMLElement.prototype.focus = function focus(this: HTMLElement) {
	if (!this.isConnected || this.hasAttribute("disabled") || this.closest("[inert]") || !this.matches(FOCUSABLE)) return;
	const previous = active;
	active = this;
	// React tracks the focused text field through focusin/focusout.
	previous?.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
	this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
};
dom.window.HTMLElement.prototype.blur = function blur(this: HTMLElement) {
	if (active !== this) return;
	active = null;
	this.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
};
Object.defineProperty(dom.document, "activeElement", {
	configurable: true,
	get: () => (active && active.isConnected && !active.closest("[inert]") ? active : dom.document.body),
});

/** Dispatch a keydown at `target`; returns the event (check defaultPrevented). */
export function press(target: Element, key: string, init: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init });
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

export function byId(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`no #${id}`);
	return el;
}

export const activeId = () => (document.activeElement as HTMLElement | null)?.id ?? "";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mount `node` into a fresh host (the "app"), replacing any earlier mount. */
export async function mount(node: React.ReactNode) {
	await unmount();
	host = document.createElement("div");
	host.id = "app";
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}

export async function rerender(node: React.ReactNode) {
	await act(async () => root!.render(node));
}

export async function unmount() {
	if (root) await act(async () => root!.unmount());
	root = null;
	host?.remove();
	host = null;
	active = null;
	document.body.innerHTML = "";
}

export { act };
