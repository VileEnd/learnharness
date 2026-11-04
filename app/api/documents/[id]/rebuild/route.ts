/**
 * POST /api/documents/[id]/rebuild - convert a .nw document and extract its
 * concepts again. Answers 202 as soon as it starts: the extraction runs in the
 * background (the activity dock shows it, a push notification closes it). 404
 * for an unknown document, 409 when there is nothing to rebuild or it is busy.
 */
import { documents, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = withTenant(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const ticket = documents.rebuild(id);
	if (!ticket.ok) {
		return Response.json({ error: ticket.error, code: ticket.code }, { status: ticket.code === "not_found" ? 404 : 409 });
	}
	return Response.json({ ok: true, docId: ticket.docId }, { status: 202 });
});
