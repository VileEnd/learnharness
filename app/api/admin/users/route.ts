/**
 * Admin Users section (Keycloak-backed).
 *   GET  → {users: AdminUser[]}
 *   POST {username, email?, admin?} → 201 {user, temporaryPassword} (password shown once, never stored)
 * Admin only; 503 user_admin_not_configured without KC_ADMIN_API_URL/SECRET.
 */
import { KeycloakError, keycloakAdmin, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const notConfigured = () => Response.json({ error: "user_admin_not_configured" }, { status: 503 });
const upstream = () => Response.json({ error: "keycloak_unavailable" }, { status: 502 });

export const GET = withTenant(async () => {
	const denied = requireAdmin();
	if (denied) return denied;
	const kc = keycloakAdmin();
	if (!kc) return notConfigured();
	try {
		return Response.json({ users: await kc.listUsers() });
	} catch {
		return upstream();
	}
});

export const POST = withTenant(async (req) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const kc = keycloakAdmin();
	if (!kc) return notConfigured();
	const body = (await req.json().catch(() => null)) as { username?: unknown; email?: unknown; admin?: unknown } | null;
	const username = body?.username;
	if (typeof username !== "string" || !USERNAME_RE.test(username)) return Response.json({ error: "invalid_username" }, { status: 400 });
	const email = typeof body?.email === "string" && body.email.trim() ? body.email.trim() : undefined;
	if (body?.email !== undefined && body.email !== "" && (typeof body.email !== "string" || !email?.includes("@"))) {
		return Response.json({ error: "invalid_email" }, { status: 400 });
	}
	try {
		const created = await kc.createUser({ username, email, admin: body?.admin === true });
		return Response.json(created, { status: 201 });
	} catch (e) {
		if (e instanceof KeycloakError && e.status === 409) return Response.json({ error: "username_taken" }, { status: 409 });
		return upstream();
	}
});
