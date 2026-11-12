/**
 * The draft view's send reads the CURRENT `mode`. Navigating from /chat/new
 * to /chat/new?mode=practice reuses the NewSession instance with a new
 * prop; a send closure that kept the first mode started a teach session
 * while the screen said practice.
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { it } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { NewSession } from "../components/new-session.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";

it("a send after the mode prop changes starts the session as that mode", async () => {
	const dom = parseHTML("<html><body></body></html>");
	const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
	Object.assign(dom.window, { matchMedia: media });
	const storage = { getItem: () => null, setItem() {}, removeItem() {} };
	class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
	const globals = {
		window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true, localStorage: storage, sessionStorage: storage,
		ResizeObserver: ResizeObserverStub, CSS: { supports: () => false, escape: (s: string) => s }, getComputedStyle: () => ({ getPropertyValue: () => "" }),
	};
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	Object.assign(globalThis, globals);
	const created: unknown[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/chats") && init?.method === "POST") {
			created.push(JSON.parse(String(init.body)));
			return Response.json({ id: "c1" });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host);
	const view = (mode: "teach" | "practice") =>
		React.createElement(
			AppRouterContext.Provider,
			{ value: router as never },
			React.createElement(ServerEventsProvider, {
				connect: () => ({ close() {}, onOpen() {}, onEvent() {} }),
				children: React.createElement(NewSession, { initialConfigured: true, mode }),
			}),
		);
	try {
		await act(async () => root.render(view("teach")));
		await act(async () => root.render(view("practice")));
		const textarea = host.querySelector("textarea") as HTMLTextAreaElement | null;
		assert(textarea, "the composer renders");
		// react-dom, imported without a DOM, falls back to its legacy change
		// detection (focus + propertychange): drive that path by hand.
		let propertyChange: ((event: { propertyName: string; target: EventTarget }) => void) | undefined;
		Object.assign(textarea, { attachEvent: (_name: string, handler: typeof propertyChange) => { propertyChange = handler; }, detachEvent() {} });
		await act(async () => {
			textarea.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
			// the prototype setter, so react's value tracker still sees a change
			Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!.call(textarea, "teach me logic");
			propertyChange?.({ propertyName: "value", target: textarea });
		});
		await act(async () => {
			const enter = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
			textarea.dispatchEvent(enter);
		});
		assert.equal(created.length, 1, "one session was created");
		assert.equal((created[0] as { kind?: string }).kind, "practice");
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = realFetch;
		for (const key of Object.keys(globals)) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
