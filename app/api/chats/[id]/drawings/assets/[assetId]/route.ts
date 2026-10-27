import { getChat, stores } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; assetId: string }> }) {
	const { id, assetId } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const asset = stores.drawingStore.getAsset(id, assetId);
	if (!asset) return Response.json({ error: "Not found" }, { status: 404 });
	return new Response(Buffer.from(asset.bytes), {
		headers: { "Content-Type": asset.mimeType, "Cache-Control": "private, max-age=31536000, immutable" },
	});
}
