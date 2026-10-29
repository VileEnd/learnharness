/** PUT UserPolicy | {useDefaults:true} → 204. Sets or clears one user's policy. 400 invalid_policy with a detail. */
import { putUserPolicy, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const PUT = withTenant(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const { id } = await params;
	return putUserPolicy(id, await req.json().catch(() => null));
});
