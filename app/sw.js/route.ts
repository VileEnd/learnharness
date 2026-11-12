import { serviceWorkerScript } from "@/src/server";

// Public by design: no tenant, no identity headers (Caddy serves /sw.js
// without the login, so an update never depends on the session).
export const dynamic = "force-dynamic";

/**
 * The service worker, served by the app instead of public/ so its bytes carry
 * the build id: that is what lets registration.update() notice a deploy in an
 * app that stays open. no-cache makes the browser revalidate it every time.
 */
export function GET(): Response {
	return new Response(serviceWorkerScript(), {
		headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" },
	});
}
