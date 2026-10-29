/**
 * GET /api/me — the signed-in account for the sidebar's "Signed in as …"
 * line: {account: {name, isAdmin, signOutUrl}}, or {account: null} in
 * single-user mode (no login, nothing to sign out of).
 */
import { accountInfo, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => Response.json({ account: accountInfo() }));
