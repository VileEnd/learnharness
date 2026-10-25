import { knowledgeViewNow } from "@/src/server";

/**
 * The "My knowledge" view (GET /api/knowledge) - thin transport: the learner
 * model, the per-topic overview and the graph of the concepts that have
 * evidence, all derived at read time. A pure read; nothing is stored.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(knowledgeViewNow());
}
