/**
 * GET /api/documents/search?q=&topic=&document=&limit= - hybrid search over
 * the library (BM25 + embeddings, merged by Reciprocal Rank Fusion). Returns
 * {mode: "hybrid" | "keyword", query, hits, note?}; keyword mode is the honest
 * fallback when no embeddings are available. Never waits on indexing.
 */
import { docIndex, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async (req: Request) => {
	const params = new URL(req.url).searchParams;
	const query = params.get("q")?.trim() ?? "";
	if (query === "") return Response.json({ error: "q is required" }, { status: 400 });
	const limit = Number(params.get("limit"));
	const result = await docIndex.search({
		query,
		topic: params.get("topic") || undefined,
		document: params.get("document") || undefined,
		includeConcepts: false, // the /documents page opens passages in the reader; a concept has none
		...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
	});
	return Response.json(result);
});
