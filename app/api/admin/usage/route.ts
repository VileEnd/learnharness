/**
 * GET → {month, users: [{userId, spentUsd, unpricedCalls, capUsd, restricted}]}.
 * Every tenant's month, folded separately. restricted is false for admins, for
 * single-user mode, and for the requesting admin when Keycloak is unknown (it
 * is true for any other user then); capUsd is null whenever restricted is
 * false. Admin only.
 */
import { adminUsage, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => requireAdmin() ?? (await adminUsage()));
