import { validateDrawingScene } from "@/src/core";
import { getChat, stores } from "@/src/server";

/** The work-dock draft for one tool call: { scene, rev }. Optimistic writes -
 *  a stale baseRev is a 409 carrying the current draft. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; callId: string }> }) {
	const { id, callId } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const draft = stores.drawingStore.readDraft(id, callId);
	if (!draft) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(draft);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; callId: string }> }) {
	const { id, callId } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	if (!/^[A-Za-z0-9_-]+$/.test(callId)) return Response.json({ error: "Invalid call id" }, { status: 400 });
	const body = (await req.json().catch(() => null)) as { scene?: unknown; baseRev?: unknown } | null;
	if (!body || typeof body.baseRev !== "number" || !Number.isInteger(body.baseRev) || body.baseRev < 0) {
		return Response.json({ error: "baseRev must be a non-negative integer" }, { status: 400 });
	}
	const scene = validateDrawingScene(body.scene);
	if (!scene.ok) return Response.json({ error: scene.error }, { status: 400 });
	const result = stores.drawingStore.writeDraft(id, callId, scene.scene, body.baseRev);
	if (!result.ok) return Response.json(result.current ?? { error: "Conflict" }, { status: 409 });
	return Response.json({ rev: result.rev });
}
