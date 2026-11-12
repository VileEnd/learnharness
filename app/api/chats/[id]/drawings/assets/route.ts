import { DRAWING_ASSET_MAX_BYTES, MULTIPART_ALLOWANCE_BYTES } from "@/src/core";
import { getChat, readUploadForm, stores, withTenant } from "@/src/server";

/** Image upload for the canvas: multipart `file`, PNG or JPEG (by magic bytes), max 5 MB (DRAWING_ASSET_MAX_BYTES). */
export const POST = withTenant(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	// Bounded read: an oversized body is refused while it streams in, never buffered whole.
	const form = await readUploadForm(req, DRAWING_ASSET_MAX_BYTES + MULTIPART_ALLOWANCE_BYTES, DRAWING_ASSET_MAX_BYTES);
	if (form instanceof Response) return form;
	const file = form.get("file");
	if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });
	if (file.size > DRAWING_ASSET_MAX_BYTES) return Response.json({ error: "image too large (max 5 MB)" }, { status: 413 });
	const bytes = new Uint8Array(await file.arrayBuffer());
	const isPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
	const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (!isPng && !isJpeg) return Response.json({ error: "only PNG or JPEG images" }, { status: 400 });
	const { assetId } = stores.drawingStore.saveAsset(id, bytes, isPng ? "image/png" : "image/jpeg");
	return Response.json({ assetId });
});
