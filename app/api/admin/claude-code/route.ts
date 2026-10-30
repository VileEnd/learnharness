/** GET → {enabled, status}: the Claude Code toggle and the runner's CLI status.
 *  PUT {enabled: boolean} → {enabled}. Admin only (403 otherwise); 400 on a bad
 *  body; 500 admin_policy_corrupt on a corrupt admin.json. */
import { claudeCodeAdminPut, claudeCodeAdminView, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => requireAdmin() ?? (await claudeCodeAdminView()));

export const PUT = withTenant(async (req: Request) => requireAdmin() ?? claudeCodeAdminPut(await req.json().catch(() => null)));
