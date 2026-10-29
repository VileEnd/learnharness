/**
 * GET /api/usage?month=YYYY-MM — one month of spend from the request log
 * (cost counter, 2026-10-29): totals, categories, days, sessions, failure
 * count. Thin transport over src/server's usageMonth(); absent month = the
 * current Europe/Berlin month. Dollars are inferred at read time.
 */
import { usageMonth } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const month = new URL(request.url).searchParams.get("month");
	if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
		return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
	}
	return Response.json(usageMonth(month ?? undefined));
}
