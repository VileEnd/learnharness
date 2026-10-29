/** DELETE → 204 (revoke: the peer entry and its address are kept), or 404 not_found. Admin only. */
import { requireAdmin, revokeDevice, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const DELETE = withTenant(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const { id } = await params;
	return revokeDevice(id) ? new Response(null, { status: 204 }) : Response.json({ error: "not_found" }, { status: 404 });
});
