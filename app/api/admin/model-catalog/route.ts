/** GET → {autoRefresh, checkedAt}: the daily model-catalog refresh switch
 *  (admin-global, absent = on) and when pi.dev was last checked.
 *  PUT {autoRefresh: boolean} → the same view. Admin only (403 otherwise);
 *  400 on a bad body; 500 admin_policy_corrupt on a corrupt admin.json. */
import { modelCatalogAdminPut, modelCatalogAdminView, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => requireAdmin() ?? modelCatalogAdminView());

export const PUT = withTenant(async (req: Request) => requireAdmin() ?? modelCatalogAdminPut(await req.json().catch(() => null)));
