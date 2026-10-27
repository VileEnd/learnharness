import { validateDrawingScene } from "@/src/core";
import { getChat, stores } from "@/src/server";

/** Learner sketch/work submission: multipart `scene` (JSON) + `png` (file).
 *  Content-addressed - the same scene is the same drawingId. */
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const form = await req.formData().catch(() => null);
	if (!form) return Response.json({ error: "Expected multipart form data" }, { status: 400 });
	const sceneRaw = form.get("scene");
	const png = form.get("png");
	if (typeof sceneRaw !== "string") return Response.json({ error: "scene is required" }, { status: 400 });
	if (!(png instanceof File)) return Response.json({ error: "png is required" }, { status: 400 });
	let parsed: unknown;
	try {
		parsed = JSON.parse(sceneRaw);
	} catch {
		return Response.json({ error: "scene is not valid JSON" }, { status: 400 });
	}
	const scene = validateDrawingScene(parsed);
	if (!scene.ok) return Response.json({ error: scene.error }, { status: 400 });
	if (png.size > MAX_PNG_BYTES) return Response.json({ error: "png too large (max 10 MB)" }, { status: 413 });
	const bytes = new Uint8Array(await png.arrayBuffer());
	if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return Response.json({ error: "png is not a PNG" }, { status: 400 });
	const { drawingId } = stores.drawingStore.saveSubmission(id, scene.scene, bytes);
	return Response.json({ drawingId });
}
