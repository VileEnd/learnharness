/**
 * POST /api/documents/check - the Add-documents dialog's duplicate check.
 * Multipart field "files" (markdown, text or PDF); one result per file, in
 * request order: {index, name, kind, verdict: {status: new | duplicate |
 * similar, of?, score?}, scanned?, error?}. Content decides, never the
 * filename. Needs no model key - it only fingerprints and compares.
 */
import { documents, incomingFiles } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const files = await incomingFiles(await request.formData());
	if (files.length === 0) return Response.json({ results: [], error: "no files" }, { status: 400 });
	return Response.json({ results: await documents.check(files) });
}
