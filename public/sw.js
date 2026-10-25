/*
 * LearnHarness service worker (browser-only self-hosting, 2026-10-25).
 *
 * Scope: make the installed app open instantly and fail gracefully.
 *   - static build assets (/_next/static/*, hashed + immutable), fonts and
 *     icons: cache-first. Old build assets are KEPT — a page opened before a
 *     deploy still asks for its own chunk hashes.
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
const STATIC_CACHE = "lh-static-v1";
const OFFLINE_URL = "/offline.html";

/**
 * @param {{ url: string, method: string, mode: string, headers: { get(name: string): string | null } }} request
 * @param {string} origin
 * @returns {"static" | "navigate" | "pass"}
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
	if (
		path.startsWith("/_next/static/") ||
		path.startsWith("/fonts/") ||
		path.startsWith("/icons/") ||
		path === "/icon.svg" ||
		path === "/apple-icon.png" ||
		path === "/manifest.webmanifest"
	) {
		return "static";
	}
	return "pass";
}
self.lhRouteFor = lhRouteFor;

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
			for (const name of await caches.keys()) {
				if (name.startsWith("lh-") && !keep.has(name)) await caches.delete(name);
			}
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
		event.respondWith(
			(async () => {
				const cache = await caches.open(STATIC_CACHE);
				const hit = await cache.match(event.request);
				if (hit) return hit;
				const res = await fetch(event.request);
				// Only real, same-origin, non-redirected successes are kept (never a
				// login redirect or an error page).
				if (res.ok && res.type === "basic" && !res.redirected) await cache.put(event.request, res.clone());
				return res;
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
