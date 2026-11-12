/**
 * Cross-site request checks, the one implementation behind withTenant (every
 * state-changing route) and the custom-provider routes (stricter).
 *
 * Why: the app has no authentication of its own. The session cookie lives at
 * the proxy, and `req.json()` parses a `text/plain` form body, so a page on
 * another site could post valid JSON with the learner's cookie. Browsers
 * stamp `Sec-Fetch-Site` (and `Origin` on writes) themselves and scripts on a
 * page cannot forge either.
 *
 * Hosts are compared the way the app sees them behind the proxy: Caddy
 * forwards the Host header untouched, and TLS ends at Caddy, so the scheme is
 * not compared. Forwarded-host headers are never trusted.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Does this Origin header name the host the request was addressed to? */
function originMatchesHost(request: Request, origin: string): boolean {
	if (origin === "null") return false;
	try {
		const host = request.headers.get("host") ?? new URL(request.url).host;
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/** Strict same-origin browser request: an Origin is REQUIRED and must match
 *  the addressed Host (custom-provider writes). */
export function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return false;
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return false;
	return originMatchesHost(request, origin);
}

/** True when a state-changing request came from another site. Reads are
 *  never checked. `Sec-Fetch-Site` decides when present (`same-origin`, or
 *  `none` for a user-initiated request, passes); otherwise a present Origin
 *  must match the Host. A request with neither header is not a browser
 *  (scripts, the Claude runner's bridge) and passes. */
export function isCrossSiteWrite(request: Request): boolean {
	if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
	const site = request.headers.get("sec-fetch-site");
	if (site !== null) return site !== "same-origin" && site !== "none";
	const origin = request.headers.get("origin");
	return origin !== null && !originMatchesHost(request, origin);
}
