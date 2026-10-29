/**
 * GET → {month, users: [{userId, spentUsd, unpricedCalls, capUsd, restricted}]}.
 * Every tenant's month, folded separately. restricted is false only for known
 * Keycloak admins (true when unknown). Admin only.
 */
import { adminUsage, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => requireAdmin() ?? (await adminUsage()));
