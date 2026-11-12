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
	assert.equal(route("/icons/icon-192.png"), "revalidate");
	assert.equal(route("/manifest.webmanifest"), "revalidate");
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

// ── the per-build cache lifecycle ────────────────────────────────────────────

type Store = Map<string, Map<string, Response>>;

/** A same-origin response, as the worker sees one from fetch() (a bare
 *  `new Response` reports type "default"). */
const basic = (body: string, init?: ResponseInit) => Object.defineProperty(new Response(body, init), "type", { value: "basic" });

/** The worker loaded on the real public/sw.js with a fake Cache Storage. */
function loadWorker(build: string | null, store: Store, network: (url: string) => Promise<Response>) {
	const handlers: Record<string, (e: unknown) => void> = {};
	const keyOf = (r: unknown) => (typeof r === "string" ? new URL(r, ORIGIN).href : (r as { url: string }).url);
	const cacheNamed = (name: string) => {
		const entries = store.get(name) ?? new Map<string, Response>();
		store.set(name, entries);
		return {
			match: async (r: unknown) => entries.get(keyOf(r))?.clone(),
			put: async (r: unknown, res: Response) => void entries.set(keyOf(r), res),
			add: async (r: unknown) => void entries.set(keyOf(r), new Response("offline")),
		};
	};
	const caches = {
		open: async (name: string) => cacheNamed(name),
		keys: async () => [...store.keys()],
		delete: async (name: string) => store.delete(name),
		match: async (r: unknown) => {
			for (const entries of store.values()) {
				const hit = entries.get(keyOf(r));
				if (hit) return hit.clone();
			}
			return undefined;
		},
	};
	const sw = {
		location: { href: `${ORIGIN}/sw.js${build === null ? "" : `?v=${build}`}`, origin: ORIGIN },
		addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
		registration: {},
		clients: { claim: async () => {} },
		skipWaiting: () => {},
	};
	vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
		self: sw,
		URL,
		Request,
		Response,
		caches,
		fetch: (r: { url: string }) => network(r.url),
	});
	const activate = async () => {
		let pending: Promise<unknown> = Promise.resolve();
		handlers.activate!({ waitUntil: (p: Promise<unknown>) => void (pending = p) });
		await pending;
	};
	const fetchEvent = async (path: string) => {
		let responded: Promise<Response> | undefined;
		const waits: Promise<unknown>[] = [];
		handlers.fetch!({
			request: { url: ORIGIN + path, method: "GET", mode: "cors", headers: { get: () => null } },
			respondWith: (p: Promise<Response>) => void (responded = p),
			waitUntil: (p: Promise<unknown>) => void waits.push(p),
		});
		const res = await responded;
		await Promise.all(waits);
		return res;
	};
	return { activate, fetchEvent };
}

const staticCaches = (store: Store) => [...store.keys()].filter((k) => k.startsWith("lh-static-")).sort();

it("names the static cache after the build and keeps only this build and the previous one", async () => {
	const store: Store = new Map();
	const net = async () => basic("x");
	// The first versioned deploy: the old unversioned cache is the previous build.
	store.set("lh-static-v1", new Map());
	store.set("lh-static-old", new Map()); // older than the previous build
	await loadWorker("b1", store, net).activate();
	assert.deepEqual(staticCaches(store), ["lh-static-b1", "lh-static-v1"]);
	await loadWorker("b2", store, net).activate();
	assert.deepEqual(staticCaches(store), ["lh-static-b1", "lh-static-b2"]);
	await loadWorker("b2", store, net).activate(); // re-activation keeps the same pair
	assert.deepEqual(staticCaches(store), ["lh-static-b1", "lh-static-b2"]);
	await loadWorker("b3", store, net).activate();
	assert.deepEqual(staticCaches(store), ["lh-static-b2", "lh-static-b3"]);
});

it("a page from before the deploy still gets its own chunks from the previous build's cache", async () => {
	const store: Store = new Map();
	let hits = 0;
	const net = async () => (hits++, basic("chunk"));
	const b1 = loadWorker("b1", store, net);
	await b1.activate();
	await b1.fetchEvent("/_next/static/chunks/old.js"); // cached under b1
	const b2 = loadWorker("b2", store, net);
	await b2.activate();
	hits = 0;
	assert.equal(await (await b2.fetchEvent("/_next/static/chunks/old.js"))!.text(), "chunk");
	assert.equal(hits, 0, "served from the cache, not the network");
});

it("serves the manifest and icons stale-while-revalidate", async () => {
	const store: Store = new Map();
	let body = "v1";
	const w = loadWorker("b1", store, async () => basic(body));
	assert.equal(await (await w.fetchEvent("/manifest.webmanifest"))!.text(), "v1", "first load: network");
	body = "v2";
	assert.equal(await (await w.fetchEvent("/manifest.webmanifest"))!.text(), "v1", "second load: the cached copy, instantly");
	assert.equal(await (await w.fetchEvent("/manifest.webmanifest"))!.text(), "v2", "and the background refresh landed");
});

it("never caches a redirected or non-OK static response", async () => {
	const store: Store = new Map();
	const w = loadWorker("b1", store, async () => basic("nope", { status: 500 }));
	await w.fetchEvent("/_next/static/chunks/bad.js");
	assert.equal(store.get("lh-static-b1")?.size ?? 0, 0);
});

it("a push without a tag does not ask to renotify (which throws)", async () => {
	const handlers: Record<string, (e: unknown) => void> = {};
	const shown: unknown[][] = [];
	const sw = {
		addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
		registration: { showNotification: async (...args: unknown[]) => void shown.push(args) },
	};
	vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self: sw, URL });
	let pending: Promise<unknown> = Promise.resolve();
	handlers.push!({ data: { json: () => ({ title: "Hi" }) }, waitUntil: (p: Promise<unknown>) => void (pending = p) });
	await pending;
	const opts = (shown[0] as [string, { tag?: string; renotify?: boolean }])[1];
	assert.ok(!(opts.renotify === true && !opts.tag), "renotify without a tag throws in showNotification");
});
it("registers the worker under a build-specific URL", async () => {
	const { serviceWorkerUrl } = await import("../components/pwa-runtime.tsx");
	assert.equal(serviceWorkerUrl("a1b2c3"), "/sw.js?v=a1b2c3");
	assert.equal(serviceWorkerUrl(undefined), "/sw.js");
});
