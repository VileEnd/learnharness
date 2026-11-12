/**
 * The browser half of push registration: signing out drops this device's
 * subscription (server record first, then the browser's), and loading with a
 * browser subscription the server may not hold registers it again. fetch and
 * the service worker registration are stubbed; nothing leaves the process.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dropPushSubscription, syncPushSubscription } from "../components/push-device.ts";

const realFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function stubBrowser(sub: { endpoint: string; unsubscribed?: number } | null, fetchImpl: typeof fetch) {
	const subscription = sub && {
		endpoint: sub.endpoint,
		toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: "p", auth: "a" } }),
		unsubscribe: async () => { sub.unsubscribed = (sub.unsubscribed ?? 0) + 1; return true; },
	};
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }) } },
	});
	globalThis.fetch = fetchImpl;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
});

describe("push device", () => {
	it("sign-out drops the server's record, then the browser's subscription - even when the server is unreachable", async () => {
		const sub: { endpoint: string; unsubscribed?: number } = { endpoint: "https://push.example/1" };
		const calls: string[] = [];
		stubBrowser(sub, async (url, init) => { calls.push(`${init?.method} ${url} ${init?.body}`); return new Response(null, { status: 204 }); });
		await dropPushSubscription();
		assert.deepEqual(calls, ['DELETE /api/push {"endpoint":"https://push.example/1"}']);
		assert.equal(sub.unsubscribed, 1);

		const down: { endpoint: string; unsubscribed?: number } = { endpoint: "https://push.example/2" };
		stubBrowser(down, async () => { throw new TypeError("network"); });
		await dropPushSubscription();
		assert.equal(down.unsubscribed, 1, "the browser's subscription goes regardless");
	});

	it("sign-out with no subscription does nothing", async () => {
		const calls: string[] = [];
		stubBrowser(null, async (url) => { calls.push(String(url)); return new Response(null, { status: 204 }); });
		await dropPushSubscription();
		assert.deepEqual(calls, []);
	});

	it("on load a browser subscription is registered with the server again; none means off and no request", async () => {
		const calls: { method?: string; body?: unknown }[] = [];
		stubBrowser({ endpoint: "https://push.example/3" }, async (_url, init) => { calls.push({ method: init?.method, body: JSON.parse(String(init?.body)) }); return new Response(null, { status: 204 }); });
		assert.equal(await syncPushSubscription(), true);
		assert.deepEqual(calls, [{ method: "POST", body: { subscription: { endpoint: "https://push.example/3", keys: { p256dh: "p", auth: "a" } } } }]);

		calls.length = 0;
		stubBrowser(null, async () => { throw new Error("no request expected"); });
		assert.equal(await syncPushSubscription(), false);
		assert.deepEqual(calls, []);
	});

	it("a refused or failed re-registration still reports the browser as subscribed and never throws", async () => {
		stubBrowser({ endpoint: "https://push.example/4" }, async () => { throw new TypeError("network"); });
		assert.equal(await syncPushSubscription(), true);
	});
});
