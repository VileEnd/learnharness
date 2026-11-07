/** GET → {conversation: "short" | "long"}: the admin-global prompt-cache retention for
 *  conversation turns (unset reads as "short", pi-ai's default).
 *  PUT {conversation} → {conversation}. Admin only (403 otherwise); 400 on a bad body;
 *  500 admin_policy_corrupt on a corrupt admin.json. */
import { cacheRetentionAdminPut, cacheRetentionAdminView, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => requireAdmin() ?? cacheRetentionAdminView());

export const PUT = withTenant(async (req: Request) => requireAdmin() ?? cacheRetentionAdminPut(await req.json().catch(() => null)));
