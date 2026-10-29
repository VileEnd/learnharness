/**
 * GET /api/usage/months — the 12-month strip (cost counter, 2026-10-29):
 * the last 12 months with a request log, oldest first, each with its priced
 * total and unpriced-call count. Thin transport over usageMonths().
 */
import { usageMonths, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => {
	return Response.json(usageMonths());
});
