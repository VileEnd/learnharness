/**
 * Identity resolution (multi-user design §2): the Keycloak user, forwarded by
 * Caddy's forward_auth (oauth2-proxy), becomes the request's Tenant. Every
 * route handler and server-rendered page runs inside withTenant /
 * withPageTenant, so all per-user state is reached through the ambient scope.
 *
 * Single-user mode (LH_MULTI_USER unset): LOCAL_TENANT, no headers needed.
 */
import { headers } from "next/headers";
import { LEGACY_FIX, legacyLayoutResponse } from "./health.ts";
import { setEventScope } from "../core/events.ts";
import {
	LOCAL_TENANT,
	TENANT_ID_RE,
	currentTenant,
	multiUser,
	runAsTenant,
	type Tenant,
} from "../core/tenant-context.ts";

// Stamp every emission with the ambient tenant. Registered here (imported by
// events-stream.ts and the server barrel) so it holds whichever loads first.
setEventScope(() => currentTenant()?.id);

export function resolveTenant(h: Headers): Tenant | null {
	if (!multiUser()) return LOCAL_TENANT;
	const id = h.get("x-auth-request-user");
	if (!id || !TENANT_ID_RE.test(id)) return null;
	const adminGroup = process.env.LH_ADMIN_GROUP || "learnharness-admin";
	const groups = (h.get("x-auth-request-groups") ?? "")
		.split(",")
		.map((g) => g.trim().replace(/^\//, ""))
		.filter(Boolean);
	return {
		id,
		name: h.get("x-auth-request-preferred-username") || h.get("x-auth-request-email") || id,
		isAdmin: groups.includes(adminGroup),
	};
}

/** Route wrapper: 401 without an identity; extra args (Next's { params }) pass through untouched. */
export function withTenant<A extends unknown[]>(
	handler: (req: Request, ...rest: A) => Response | Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
	return async (req, ...rest) => {
		const legacy = legacyLayoutResponse();
		if (legacy) return legacy;
		const tenant = resolveTenant(req?.headers ?? new Headers());
		if (!tenant) return Response.json({ error: "unauthenticated" }, { status: 401 });
		return runAsTenant(tenant, () => handler(req, ...rest));
	};
}

/** Page wrapper: pages sit behind forward_auth, so no tenant means a misconfigured proxy: throw. */
export async function withPageTenant<T>(fn: () => T | Promise<T>): Promise<T> {
	if (legacyLayoutResponse()) throw new Error(`legacy_layout: single-user data not migrated yet; run \`${LEGACY_FIX}\``);
	const tenant = resolveTenant(await headers());
	if (!tenant) throw new Error("withPageTenant: no tenant resolved (is the auth proxy forwarding x-auth-request-user?)");
	return runAsTenant(tenant, fn);
}

/** Instance-wide writes (keys, prompt overrides): 403 for non-admins in multi-user mode (LOCAL_TENANT is an admin). Call first in the handler. */
export function requireAdmin(): Response | null {
	return currentTenant()?.isAdmin ? null : Response.json({ error: "admin_only" }, { status: 403 });
}
