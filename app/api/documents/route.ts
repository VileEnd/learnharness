/**
 * GET /api/documents - the library list: every document's meta (title,
 * summary, topics, filenames as aliases, pages, dates, sections) without
 * its duplicate-detection sketch, newest import first.
 */
import { documents } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ documents: documents.list() });
}
