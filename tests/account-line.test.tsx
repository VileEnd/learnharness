import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AccountLine } from "../components/account-line.tsx";

const realFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
	globalThis.fetch = realFetch;
	if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
});

it("mounting the account line registers the browser's push subscription once, without Settings being opened", async () => {
	const dom = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
	const sub = { endpoint: "https://push.example/9", toJSON: () => ({ endpoint: "https://push.example/9", keys: { p256dh: "p", auth: "a" } }) };
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => sub } }) } },
	});
	const posts: unknown[] = [];
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		if (String(url) === "/api/push" && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
		return Response.json({ account: null });
	}) as typeof fetch;
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host);
	await act(async () => { root.render(<AccountLine />); });
	await act(async () => { await new Promise((r) => setImmediate(r)); });
	assert.deepEqual(posts, [{ subscription: { endpoint: "https://push.example/9", keys: { p256dh: "p", auth: "a" } } }]);
	await act(async () => { root.unmount(); });
});
