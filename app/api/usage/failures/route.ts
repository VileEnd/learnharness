/**
 * GET /api/usage/failures?month=YYYY-MM&page=N — the failed requests of a
 * month (cost counter, 2026-10-29), newest first, 50 per page. Absent month
 * = the current Europe/Berlin month; absent page = 0. Thin transport over
 * usageFailures().
 */
import { monthKey } from "@/src/core";
import { usageFailures } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const month = params.get("month");
	const page = params.get("page");
	if (month !== null && !/^\d{4}-\d{2}$/.test(month)) {
		return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
	}
	if (page !== null && !/^\d+$/.test(page)) {
		return Response.json({ error: "page must be a non-negative integer" }, { status: 400 });
	}
	return Response.json(usageFailures(month ?? monthKey(new Date()), page === null ? 0 : Number(page)));
}
