/** The service worker's routing table, exercised on the real public/sw.js. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";
import { it } from "node:test";

const ORIGIN = "https://learnharness.example";
const self: { lhRouteFor?: (req: unknown, origin: string) => string; addEventListener: () => void } = {
	addEventListener: () => {},
};
vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL });
const route = (path: string, opts: { method?: string; mode?: string; headers?: Record<string, string> } = {}) =>
	self.lhRouteFor!(
		{
			url: path.startsWith("http") ? path : ORIGIN + path,
			method: opts.method ?? "GET",
			mode: opts.mode ?? "cors",
			headers: { get: (name: string) => opts.headers?.[name.toLowerCase()] ?? null },
		},
		ORIGIN,
	);

it("caches static assets, guards navigations, and leaves the API, auth and streams alone", () => {
	assert.equal(route("/_next/static/chunks/app.js"), "static");
	assert.equal(route("/icons/icon-192.png"), "static");
	assert.equal(route("/chat/abc", { mode: "navigate" }), "navigate");
	assert.equal(route("/api/chats"), "pass");
	assert.equal(route("/api/events", { headers: { accept: "text/event-stream" } }), "pass");
	assert.equal(route("/oauth2/sign_in", { mode: "navigate" }), "pass");
	assert.equal(route("/_next/static/x.js", { method: "POST" }), "pass");
	assert.equal(route("/chat/abc", { headers: { rsc: "1" } }), "pass");
	assert.equal(route("https://auth.example/realms/x", { mode: "navigate" }), "pass");
});

it("shows a tagged notification on push and routes the click", async () => {
	const handlers: Record<string, (e: unknown) => void> = {};
	const shown: unknown[][] = [];
	const calls: string[] = [];
	const win = { focus: async () => calls.push("focus"), navigate: async (u: string) => calls.push(`navigate ${u}`) };
	const sw = {
		addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
		registration: { showNotification: async (...args: unknown[]) => void shown.push(args) },
		clients: { matchAll: async () => [win], openWindow: async (u: string) => calls.push(`open ${u}`) },
	};
	vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self: sw, URL });
	let pending: Promise<unknown> = Promise.resolve();
	const waitUntil = (p: Promise<unknown>) => void (pending = p);
	const payload = { title: "Algebra", body: "Your teacher replied", url: "/chat/c1", tag: "chat:c1" };
	handlers.push!({ data: { json: () => payload }, waitUntil });
	await pending;
	const [title, opts] = shown[0] as [string, { tag: string; renotify: boolean; data: { url: string } }];
	assert.equal(title, "Algebra");
	assert.deepEqual([opts.tag, opts.renotify, opts.data.url], ["chat:c1", true, "/chat/c1"]);
	handlers.notificationclick!({ notification: { close: () => calls.push("close"), data: opts.data }, waitUntil });
	await pending;
	assert.deepEqual(calls, ["close", "focus", "navigate /chat/c1"]);
});
