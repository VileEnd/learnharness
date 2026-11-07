/** The phone photo as a drawing submission: the pure decisions (EXIF orientation, size caps, the one-image scene)
 *  and that what uploadPhoto sends passes the real /drawings and /drawings/assets routes. Isolated LH_DATA_DIR. */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-photo-"));
process.env.LH_DATA_DIR = TMP;
const core = await import("../src/core/index.ts");
const { stores } = await import("../src/server/stores.ts");
const drawings = await import("../app/api/chats/[id]/drawings/route.ts");
const assets = await import("../app/api/chats/[id]/drawings/assets/route.ts");
const { uploadPhoto } = await import("../components/canvas/photo-prepare.ts");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const {
	EXIF_PROBE_JPEG_BASE64, PHOTO_MAX_SIDE, DRAWING_PNG_MAX_BYTES, DRAWING_ASSET_MAX_BYTES, PHOTO_PNG_BUDGET_BYTES, PHOTO_ASSET_BUDGET_BYTES,
	fitLongSide, orientationTransform, orientedSize, photoScene, photoSideLadder, readExifOrientation, regionGrid, sceneBoundingBox, validateDrawingScene,
} = core;

/** SOI + one APP1 EXIF segment whose IFD0 holds only the orientation tag. */
function jpegWithOrientation(value: number, little = false): Uint8Array {
	const u16 = (n: number) => (little ? [n & 255, n >> 8] : [n >> 8, n & 255]);
	const u32 = (n: number) => (little ? [n & 255, 0, 0, 0] : [0, 0, 0, n & 255]);
	const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(0x2a), ...u32(8), ...u16(1), ...u16(0x112), ...u16(3), ...u32(1), ...u16(value), 0, 0, ...u32(0)];
	const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
	return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body, 0xff, 0xda, 0, 2]);
}

describe("EXIF orientation", () => {
	it("reads every value, both byte orders", () => {
		for (let o = 1; o <= 8; o++) {
			assert.equal(readExifOrientation(jpegWithOrientation(o)), o);
			assert.equal(readExifOrientation(jpegWithOrientation(o, true)), o);
		}
	});

	it("upright when absent, out of range, truncated or not a JPEG", () => {
		assert.equal(readExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), 1);
		assert.equal(readExifOrientation(jpegWithOrientation(9)), 1);
		assert.equal(readExifOrientation(jpegWithOrientation(6).slice(0, 20)), 1);
		assert.equal(readExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 1);
		assert.equal(readExifOrientation(new Uint8Array()), 1);
	});

	it("the probe image is stored rotated (orientation 6)", () => {
		assert.equal(readExifOrientation(new Uint8Array(Buffer.from(EXIF_PROBE_JPEG_BASE64, "base64"))), 6);
	});

	it("the transform maps the raw corners onto the upright canvas, and 6 / 8 / 3 turn the way EXIF says", () => {
		const raw = { w: 400, h: 300 };
		for (let o = 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; o <= 8; o++) {
			const size = orientedSize(raw.w, raw.h, o);
			assert.deepEqual(size, o >= 5 ? { w: 300, h: 400 } : raw);
			const [a, b, c, d, e, f] = orientationTransform(o, raw.w, raw.h);
			const at = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
			const corners = [at(0, 0), at(raw.w, 0), at(0, raw.h), at(raw.w, raw.h)].map((p) => p.join(","));
			assert.deepEqual([...corners].sort(), [[0, 0], [size.w, 0], [0, size.h], [size.w, size.h]].map((p) => p.join(",")).sort(), `orientation ${o}`);
			if (o === 6) assert.deepEqual(at(0, 0), [300, 0]); // the raw top-left is the upright top-right
			if (o === 8) assert.deepEqual(at(0, 0), [0, 400]);
			if (o === 3) assert.deepEqual(at(0, 0), [400, 300]);
		}
	});
});

describe("photo sizes", () => {
	it("caps the long side at 2048 and never upscales", () => {
		assert.deepEqual(fitLongSide(4000, 3000, PHOTO_MAX_SIDE), { w: 2048, h: 1536 });
		assert.deepEqual(fitLongSide(3000, 4000, PHOTO_MAX_SIDE), { w: 1536, h: 2048 });
		assert.deepEqual(fitLongSide(800, 600, PHOTO_MAX_SIDE), { w: 800, h: 600 });
	});

	it("the ladder starts at the cap and steps down; the budgets sit under the route limits", () => {
		assert.deepEqual(photoSideLadder(4032, 3024), [2048, 1600, 1280, 1024, 768, 512]);
		assert.deepEqual(photoSideLadder(800, 600), [800, 768, 512]);
		assert.deepEqual(photoSideLadder(300, 200), [300]);
		assert.ok(PHOTO_PNG_BUDGET_BYTES < DRAWING_PNG_MAX_BYTES && PHOTO_ASSET_BUDGET_BYTES < DRAWING_ASSET_MAX_BYTES);
	});

	it("a photo scene is one image object at pixel size, with a square-cell grid like any canvas export", () => {
		const scene = photoScene(2048, 1536, "ast_0123456789ab");
		assert.deepEqual(validateDrawingScene(scene), { ok: true, scene });
		assert.deepEqual(scene.objects.map((o) => o.id), ["o1"]);
		const box = sceneBoundingBox(scene)!;
		assert.equal(regionGrid(box).rows, 6);
		assert.ok(Math.max(box.w, box.h) / PHOTO_MAX_SIDE < 1.04); // the export scale stays near 1: the PNG stays about 2048
	});
});

describe("the submission passes the routes", () => {
	const chat = stores.chatStore.createChat("t");
	/** Signature + IHDR declaring the size (the routes judge the header; no pixels needed). */
	function pngOf(width: number, height: number): Blob {
		const bytes = new Uint8Array(33);
		bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
		new DataView(bytes.buffer).setUint32(16, width);
		new DataView(bytes.buffer).setUint32(20, height);
		return new Blob([bytes], { type: "image/png" });
	}
	const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])], { type: "image/jpeg" });
	const params = { params: Promise.resolve({ id: chat.id }) };
	/** uploadPhoto's fetch, answered by the real route handlers. */
	const routes = (async (url: string, init: RequestInit) => {
		const req = new Request(`http://x${url}`, init);
		return url.endsWith("/drawings/assets") ? assets.POST(req, params) : drawings.POST(req, params);
	}) as unknown as typeof fetch;

	it("stores a one-image drawing with its PNG and asset", async () => {
		const png = pngOf(2112, 1600);
		const drawingId = await uploadPhoto(chat.id, { w: 2048, h: 1536, png, jpeg }, routes);
		const scene = stores.drawingStore.getScene(chat.id, drawingId)!;
		assert.equal(scene.objects.length, 1);
		const image = scene.objects[0]!;
		assert.ok(image.type === "image" && image.w === 2048 && image.h === 1536);
		assert.ok(image.type === "image" && stores.drawingStore.getAsset(chat.id, image.assetId)?.mimeType === "image/jpeg");
		assert.equal(stores.drawingStore.getPng(chat.id, drawingId)?.length, 33);
	});

	it("a refusal from the route reaches the learner as its message", async () => {
		await assert.rejects(uploadPhoto(chat.id, { w: 100, h: 100, png: pngOf(5000, 5000), jpeg }, routes), /4096 pixels per side/);
	});
});
