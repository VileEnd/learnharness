/*
 * LearnHarness service worker (browser-only self-hosting, 2026-10-25).
 *
 * Scope: make the installed app open instantly and fail gracefully.
 *   - static build assets (/_next/static/*, hashed + immutable): cache-first.
 *     The static cache is named after the build (the page registers
 *     /sw.js?v=<build id>, so the worker differs per deploy and the browser
 *     notices it). The previous build's cache is KEPT — a page opened before
 *     a deploy still asks for its own chunk hashes — and older ones are
 *     pruned on activate.
 *   - the manifest, icons and fonts (unhashed): stale-while-revalidate.
 *   - page navigations: network-only with the ORIGINAL request (so a login
 *     redirect to Keycloak keeps working); a network failure shows
 *     /offline.html. Pages are never cached (per-user, behind the login).
 *   - everything else is left to the browser: /api/* (incl. the SSE
 *     streams), /oauth2/*, RSC payloads, non-GET, range and cross-origin
 *     requests (Deepgram, Keycloak, sandboxed demo frames).
 *
 * The routing decision is a pure function exposed as self.lhRouteFor so the
 * test suite can exercise this exact file (tests/service-worker.test.ts).
 */

const SHELL_CACHE = "lh-shell-v1";
const STATIC_PREFIX = "lh-static-";
// The build id rides the script URL (components/pwa-runtime.tsx).
const BUILD_ID = (() => {
	try {
		return new URL(self.location.href).searchParams.get("v") || "0";
	} catch {
		return "0";
	}
})();
const STATIC_CACHE = STATIC_PREFIX + BUILD_ID;
// Which build ids this device has seen, kept in the shell cache.
const BUILDS_KEY = "/__lh-builds";
// Before builds were versioned the one static cache was "lh-static-v1": the
// first versioned deploy keeps it as its "previous" build.
const LEGACY_BUILD_ID = "v1";
const OFFLINE_URL = "/offline.html";

/**
 * @param {{ url: string, method: string, mode: string, headers: { get(name: string): string | null } }} request
 * @param {string} origin
 * @returns {"static" | "revalidate" | "navigate" | "pass"}
 */
function lhRouteFor(request, origin) {
	if (request.method !== "GET") return "pass";
	let url;
	try {
		url = new URL(request.url);
	} catch {
		return "pass";
	}
	if (url.origin !== origin) return "pass";
	if (request.headers.get("range")) return "pass";
	if (request.headers.get("rsc") || url.searchParams.has("_rsc")) return "pass";
	const accept = request.headers.get("accept") || "";
	if (accept.includes("text/event-stream")) return "pass";
	const path = url.pathname;
	if (path.startsWith("/api/") || path.startsWith("/oauth2/")) return "pass";
	if (request.mode === "navigate") return "navigate";
	if (path.startsWith("/_next/static/")) return "static";
	if (
		path.startsWith("/fonts/") ||
		path.startsWith("/icons/") ||
		path === "/icon.svg" ||
		path === "/apple-icon.png" ||
		path === "/manifest.webmanifest"
	) {
		return "revalidate";
	}
	return "pass";
}
self.lhRouteFor = lhRouteFor;

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))));
});

/** Record this build and drop every static cache older than the previous one. */
async function pruneStaticCaches() {
	const shell = await caches.open(SHELL_CACHE);
	let seen = { current: undefined, previous: undefined };
	try {
		const recorded = await shell.match(BUILDS_KEY);
		if (recorded) seen = await recorded.json();
	} catch {
		/* unreadable record: treated as the first versioned deploy */
	}
	// A re-activation of this same build keeps its pair; a new build's
	// previous is whatever was current (or the pre-versioning cache).
	const previous = seen.current === BUILD_ID ? seen.previous : seen.current || LEGACY_BUILD_ID;
	await shell.put(
		BUILDS_KEY,
		new Response(JSON.stringify({ current: BUILD_ID, previous }), { headers: { "content-type": "application/json" } }),
	);
	await caches.open(STATIC_CACHE);
	const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
	if (previous) keep.add(STATIC_PREFIX + previous);
	for (const name of await caches.keys()) {
		if (name.startsWith("lh-") && !keep.has(name)) await caches.delete(name);
	}
}

/** Only real, same-origin, non-redirected successes are kept (never a login
 *  redirect or an error page). */
const cacheable = (res) => res.ok && res.type === "basic" && !res.redirected;

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			await pruneStaticCaches();
			if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
			await self.clients.claim();
		})(),
	);
});

// The page's "Reload" on a new version (components/pwa-runtime.tsx).
self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
	const route = lhRouteFor(event.request, self.location.origin);
	if (route === "navigate") {
		event.respondWith(
			(async () => {
				try {
					const preloaded = await event.preloadResponse;
					if (preloaded) return preloaded;
					return await fetch(event.request);
				} catch {
					const offline = await caches.match(OFFLINE_URL);
					return offline || Response.error();
				}
			})(),
		);
	} else if (route === "static") {
		// Hashed and immutable: any build's copy is right, so look in all of
		// them (a page from before the deploy asks for its own chunks).
		event.respondWith(
			(async () => {
				const hit = await caches.match(event.request);
				if (hit) return hit;
				const res = await fetch(event.request);
				if (cacheable(res)) await (await caches.open(STATIC_CACHE)).put(event.request, res.clone());
				return res;
			})(),
		);
	} else if (route === "revalidate") {
		// Unhashed (manifest, icons, fonts): answer from this build's cache at
		// once and refresh it in the background, so a change lands next load.
		event.respondWith(
			(async () => {
				const cache = await caches.open(STATIC_CACHE);
				const hit = await cache.match(event.request);
				const refresh = fetch(event.request).then(async (res) => {
					if (cacheable(res)) await cache.put(event.request, res.clone());
					return res;
				});
				if (hit) {
					event.waitUntil(refresh.catch(() => undefined));
					return hit;
				}
				return refresh;
			})(),
		);
	}
	// "pass": no respondWith — the browser handles the request untouched.
});

// Web Push (mobile E). Payload from src/server/push.ts: { title, body, url,
// tag }. The tag makes each chat one notification that updates in place
// (renotify re-alerts when it does).
self.addEventListener("push", (event) => {
	let p = {};
	try {
		p = event.data ? event.data.json() : {};
	} catch {
		/* not JSON - show the generic notification */
	}
	event.waitUntil(
		self.registration.showNotification(p.title || "LearnHarness", {
			body: p.body || "",
			tag: p.tag,
			renotify: true,
			icon: "/icons/icon-192.png",
			badge: "/icons/icon-96.png",
			data: { url: p.url || "/" },
		}),
	);
});

// Tap: focus an open window (navigating it to the target) or open a new one.
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = (event.notification.data && event.notification.data.url) || "/";
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = windows[0];
			if (open) {
				await open.focus();
				if ("navigate" in open) await open.navigate(url).catch(() => undefined);
			} else {
				await self.clients.openWindow(url);
			}
		})(),
	);
});
