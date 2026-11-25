import { ATTACHMENT_IMAGE_MAX_BYTES, MULTIPART_ALLOWANCE_BYTES, checkImageDimensions, sniffImageType } from "@/src/core";
import { getChat, readUploadForm, stores, withTenant } from "@/src/server";

/** An image attached to a message or a thinking field: multipart `file`, PNG, JPEG, WebP or GIF judged by its bytes
 *  (never the name or the declared type), at most ATTACHMENT_IMAGE_MAX_BYTES, at most 4096 px per side read from the
 *  header before anything decodes it. Content-addressed: the same bytes are the same id. The browser re-encodes
 *  every image first (EXIF and GPS stripped); this route trusts none of that. */
export const POST = withTenant(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	// Bounded read: an oversized body is refused while it streams in, never buffered whole.
	const form = await readUploadForm(req, ATTACHMENT_IMAGE_MAX_BYTES + MULTIPART_ALLOWANCE_BYTES, ATTACHMENT_IMAGE_MAX_BYTES);
	if (form instanceof Response) return form;
	const file = form.get("file");
	if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });
	if (file.size > ATTACHMENT_IMAGE_MAX_BYTES) return Response.json({ error: "image too large (max 5 MB)" }, { status: 413 });
	const bytes = new Uint8Array(await file.arrayBuffer());
	const type = sniffImageType(bytes);
	if (!type) return Response.json({ error: "only PNG, JPEG, WebP or GIF images" }, { status: 400 });
	const dimensions = checkImageDimensions(bytes, type);
	if (!dimensions.ok) return Response.json({ error: dimensions.error }, { status: 413 });
	const { id: attachmentId } = stores.attachmentStore.saveImage(id, bytes, type);
	return Response.json({ id: attachmentId, kind: "image" });
});
