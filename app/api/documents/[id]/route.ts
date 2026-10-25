/**
 * GET /api/documents/[id] - one document: {meta, markdown} (the full stored
 * markdown, page markers included). 404 for an unknown id.
 */
import { documents } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const found = documents.get(id);
	if (!found) return Response.json({ error: "No such document" }, { status: 404 });
	return Response.json(found);
}
