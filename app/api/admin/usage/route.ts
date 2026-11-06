/**
 * GET → {month, users: [{userId, spentUsd, unpricedCalls, capUsd, restricted, cacheHitRate}]}.
 * Every tenant's month, folded separately. restricted is false for admins, for
 * single-user mode, and for the requesting admin when Keycloak is unknown (it
 * is true for any other user then); cacheHitRate is the user's observed month
 * rate (reads over prompt tokens) or null when there is no data; capUsd is null whenever restricted is
 * false. Admin only.
 */
import { adminUsage, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => requireAdmin() ?? (await adminUsage()));
