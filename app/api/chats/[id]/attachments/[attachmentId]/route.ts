import { getChat, stores, withTenant } from "@/src/server";

/** One attached image, to its own tenant only (withTenant scopes the store to the caller's data dir). Content-
 *  addressed, so it is immutable; served with the type it was stored under and never sniffed. */
export const GET = withTenant(async (_req: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) => {
	const { id, attachmentId } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const image = stores.attachmentStore.getImage(id, attachmentId);
	if (!image) return Response.json({ error: "Not found" }, { status: 404 });
	return new Response(Buffer.from(image.bytes), {
		headers: {
			"Content-Type": image.mimeType,
			"Cache-Control": "private, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
		},
	});
});
