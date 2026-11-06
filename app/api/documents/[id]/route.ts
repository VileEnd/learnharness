/**
 * GET /api/documents/[id] - one document: {meta, markdown, removal} (the full
 * stored markdown, page markers included; removal = the concepts a delete
 * would take and the shared ones it would leave). 404 for an unknown id.
 *
 * PATCH /api/documents/[id] {title} - rename; the title is kept by re-describe,
 * rebuild and replace. 400 for an empty or overlong title, 404 for an unknown id.
 *
 * DELETE /api/documents/[id] - delete the document and every concept only it
 * supports. 404 for an unknown id, 409 while an extraction is running.
 */
import { documents, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const found = documents.get(id);
	if (!found) return Response.json({ error: "No such document" }, { status: 404 });
	return Response.json(found);
});

export const PATCH = withTenant(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string") return Response.json({ error: "title must be a string" }, { status: 400 });
	const result = documents.rename(id, body.title);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.code === "not_found" ? 404 : 400 });
	return Response.json(result);
});

export const DELETE = withTenant(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const result = documents.remove(id);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.code === "not_found" ? 404 : 409 });
	return Response.json(result);
});
