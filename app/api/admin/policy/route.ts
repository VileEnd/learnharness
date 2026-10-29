/** GET → {defaults: UserPolicy, users: {[id]: UserPolicy}}. Admin only; 500 admin_policy_corrupt on a corrupt admin.json. */
import { adminPolicyView, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => requireAdmin() ?? (await adminPolicyView()));
