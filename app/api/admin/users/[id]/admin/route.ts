/** PUT {admin: boolean} → 204. Grants/revokes the admin group; an admin cannot demote themselves (409 self_demotion). */
import { KeycloakClientRejected, KeycloakError, currentTenant, keycloakAdmin, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const PUT = withTenant(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const kc = keycloakAdmin();
	if (!kc) return Response.json({ error: "user_admin_not_configured" }, { status: 503 });
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { admin?: unknown } | null;
	if (typeof body?.admin !== "boolean") return Response.json({ error: "invalid_body" }, { status: 400 });
	if (!body.admin && id === currentTenant()?.id) return Response.json({ error: "self_demotion" }, { status: 409 });
	try {
		await kc.setAdmin(id, body.admin);
		return new Response(null, { status: 204 });
	} catch (e) {
		if (e instanceof KeycloakError && e.status === 404) return Response.json({ error: "not_found" }, { status: 404 });
		if (e instanceof KeycloakClientRejected) return Response.json({ error: "user_admin_not_configured" }, { status: 503 });
		return Response.json({ error: "keycloak_unavailable" }, { status: 502 });
	}
});
