import { learnerSnapshotNow } from "@/src/server";

/**
 * The learner model (GET /api/learner) - thin transport: the shared server
 * seam derives a state per concept from the chat records + attribution ledger
 * at read time. A pure read; nothing is stored.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(learnerSnapshotNow());
}
