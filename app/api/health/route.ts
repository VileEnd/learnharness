/**
 * GET /api/health — container healthcheck. 200 {ok:true}, or 503 with the
 * migration command while a pre-multi-user data layout is present. Not
 * tenant-wrapped. Thin transport over src/server's healthStatus().
 */
import { healthStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const { status, body } = healthStatus();
	return Response.json(body, { status });
}
