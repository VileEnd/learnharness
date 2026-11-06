/**
 * POST /api/documents/check - the Add-documents dialog's duplicate check.
 * Multipart field "files" (markdown, text or PDF); one result per file, in
 * request order: {index, name, kind, verdict: {status: new | duplicate |
 * similar, of?, score?}, scanned?, error?}. Content decides, never the
 * filename. Needs no model key - it only fingerprints and compares.
 */
import { documents, incomingFiles, readUploadForm, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = withTenant(async (request: Request) => {
	const form = await readUploadForm(request);
	if (form instanceof Response) return form;
	const files = await incomingFiles(form);
	if (files.length === 0) return Response.json({ results: [], error: "no files" }, { status: 400 });
	return Response.json({ results: await documents.check(files) });
});
