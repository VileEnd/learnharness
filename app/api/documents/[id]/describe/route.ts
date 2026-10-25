/**
 * POST /api/documents/[id]/describe - regenerate a document's title, summary
 * and topics from its stored content (no re-extraction). For documents whose
 * front matter only carried a filename-derived title.
 */
import { documents } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = await documents.redescribe(id);
	return Response.json(result, { status: result.ok ? 200 : result.error === "No such document" ? 404 : 500 });
}
