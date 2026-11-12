/**
 * linkedom with the two things the modal tests need that it lacks: a focus
 * model (focus(), document.activeElement) that behaves like a browser for
 * inert, disabled and removed elements, and keydown dispatch. The model is
 * this file's assumption about browsers (HTML "focusable area" rules); real
 * focus, inert and Tab order are not verified here.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

export const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

let active: Element | null = null;
dom.window.HTMLElement.prototype.focus = function focus(this: HTMLElement) {
	if (!this.isConnected || this.hasAttribute("disabled") || this.closest("[inert]")) return;
	active = this;
};
dom.window.HTMLElement.prototype.blur = function blur(this: HTMLElement) {
	if (active === this) active = null;
};
Object.defineProperty(dom.document, "activeElement", {
	configurable: true,
	get: () => (active && active.isConnected && !active.closest("[inert]") ? active : dom.document.body),
});

/** Dispatch a keydown at `target`; returns the event (check defaultPrevented). */
export function press(target: Element, key: string, init: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init });
	target.dispatchEvent(event);
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
