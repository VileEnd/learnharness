/**
 * A phone photo as a drawing submission (client side). `preparePhoto` makes the photo upright (EXIF), scales it to
 * at most PHOTO_MAX_SIDE on the long side, strips its metadata by re-drawing it, and encodes the two files a drawing
 * submission needs: a JPEG for the image asset and the PNG snapshot (photo plus the region grid, exactly what a
 * canvas export would hold for a scene of one image). Nothing is sent. `uploadPhoto` then POSTs the asset and the
 * `/drawings` form with a one-image scene, so the grid, vision transcript, `annotate` marks and thumbnails all
 * work as for a drawn submission. The pure decisions (orientation, caps, ladder, scene) live in src/core/photo.ts.
 */
import {
	EXIF_PROBE_JPEG_BASE64,
	PHOTO_ASSET_BUDGET_BYTES,
	PHOTO_MAX_SIDE,
	PHOTO_PNG_BUDGET_BYTES,
	fitLongSide,
	orientationTransform,
	orientedSize,
	photoScene,
	photoSideLadder,
	readExifOrientation,
	sceneBoundingBox,
} from "@/src/core";
import type { ExifOrientation } from "@/src/core";
import { paintRegionGrid } from "./canvas-engine.ts";
import { uploadAsset } from "./canvas-objects";

export type PreparedPhoto = { w: number; h: number; png: Blob; jpeg: Blob };

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("This photo could not be read."));
		img.src = src;
	});
}

let exifApplied: Promise<boolean> | undefined;
/** Does this browser show a JPEG upright from its EXIF orientation (every current phone browser does)? Probed once
 *  with a 2x1 image stored as orientation 6; if it is not, the transform is applied here. */
function browserAppliesExif(): Promise<boolean> {
	exifApplied ??= loadImage(`data:image/jpeg;base64,${EXIF_PROBE_JPEG_BASE64}`)
		.then((img) => img.naturalWidth === 1 && img.naturalHeight === 2)
		.catch(() => true);
	return exifApplied;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the photo."))), type, quality));
}

/** The photo upright at `to` size on a white canvas. */
function drawUpright(img: HTMLImageElement, orientation: ExifOrientation, to: { w: number; h: number }): HTMLCanvasElement {
	const raw = { w: img.naturalWidth, h: img.naturalHeight };
	const upright = orientedSize(raw.w, raw.h, orientation);
	const canvas = document.createElement("canvas");
	canvas.width = to.w;
	canvas.height = to.h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("This browser cannot prepare the photo.");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, to.w, to.h);
	const [a, b, c, d, e, f] = orientationTransform(orientation, raw.w, raw.h);
	const k = to.w / upright.w;
	ctx.setTransform(k * a, k * b, k * c, k * d, k * e, k * f);
	ctx.drawImage(img, 0, 0);
	return canvas;
}

/** The PNG a canvas export of the photo scene holds: the photo on white, in the scene's bounding box, with the grid
 *  (same box as the server's, so cell labels and `annotate` anchors agree). One scene unit is one pixel. */
async function renderPng(photo: HTMLCanvasElement): Promise<Blob> {
	const scene = photoScene(photo.width, photo.height, "");
	const box = sceneBoundingBox(scene)!;
	const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(box.w, box.h));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(box.w * scale));
	canvas.height = Math.max(1, Math.round(box.h * scale));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("This browser cannot prepare the photo.");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
	ctx.drawImage(photo, 0, 0);
	paintRegionGrid(ctx, scene, box, scale);
	const png = await toBlob(canvas, "image/png");
	canvas.width = 0;
	return png;
}

/** Upright, at most 2048 on the long side, both files within the routes' limits (a smaller size is tried when the
 *  PNG of a detailed photo is over budget). Throws a message fit for the learner. */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
	const url = URL.createObjectURL(file);
	let img: HTMLImageElement;
	try {
		img = await loadImage(url);
	} finally {
		URL.revokeObjectURL(url);
	}
	const orientation: ExifOrientation = (await browserAppliesExif()) ? 1 : readExifOrientation(new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer()));
	const upright = orientedSize(img.naturalWidth, img.naturalHeight, orientation);
	if (upright.w < 1 || upright.h < 1) throw new Error("This photo could not be read.");
	for (const side of photoSideLadder(upright.w, upright.h)) {
		const to = fitLongSide(upright.w, upright.h, side);
		const canvas = drawUpright(img, orientation, to);
		try {
			const jpeg = await toBlob(canvas, "image/jpeg", 0.9);
			if (jpeg.size > PHOTO_ASSET_BUDGET_BYTES) continue;
			const png = await renderPng(canvas);
			if (png.size > PHOTO_PNG_BUDGET_BYTES) continue;
			return { ...to, png, jpeg };
		} finally {
			canvas.width = 0;
		}
	}
	throw new Error("This photo is too large to send. Try a smaller one.");
}

/** Sends the prepared photo as a drawing: the JPEG as an image asset, then the one-image scene with its PNG to
 *  `/drawings`. Resolves to the drawingId that the submission carries. */
export async function uploadPhoto(chatId: string, photo: PreparedPhoto, fetchLike: typeof fetch = fetch): Promise<string> {
	const assetId = await uploadAsset(chatId, photo.jpeg, fetchLike);
	const form = new FormData();
	form.set("scene", JSON.stringify(photoScene(photo.w, photo.h, assetId)));
	form.set("png", photo.png, "photo.png");
	const res = await fetchLike(`/api/chats/${encodeURIComponent(chatId)}/drawings`, { method: "POST", body: form });
	if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The photo upload failed (${res.status}).`);
	return ((await res.json()) as { drawingId: string }).drawingId;
}
