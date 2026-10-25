/**
 * POST /api/documents/reindex - embed every document again with the current
 * embedding model (Settings > Agent > Documents). Returns at once: the work
 * runs in the background and shows as an activity-dock row.
 */
import { docIndex } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	return Response.json({ ok: true, ...docIndex.reindex() });
}
