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
