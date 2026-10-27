import { getChat, stores } from "@/src/server";

const IMMUTABLE = "private, max-age=31536000, immutable";

/** GET ?format=png -> the snapshot (content-addressed, immutable); else { scene }. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; drawingId: string }> }) {
	const { id, drawingId } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	if (new URL(req.url).searchParams.get("format") === "png") {
		const png = stores.drawingStore.getPng(id, drawingId);
		if (!png) return Response.json({ error: "Not found" }, { status: 404 });
		return new Response(Buffer.from(png), { headers: { "Content-Type": "image/png", "Cache-Control": IMMUTABLE } });
	}
	const scene = stores.drawingStore.getScene(id, drawingId);
	if (!scene) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ scene });
}
