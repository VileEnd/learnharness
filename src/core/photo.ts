/**
 * Phone photo to drawing submission (pure, browser-safe). A phone has no canvas, so a learner's photo is
 * submitted as a drawing whose scene is just that image: the same `/drawings` route, grid, transcript,
 * `annotate` marks and thumbnails as a canvas submission. The browser does the pixels (components/canvas/
 * photo-prepare.ts); the decisions that can be pure live here: the EXIF orientation read and its transform,
 * the size caps and the ladder of smaller sizes tried when a PNG is over budget, and the one-image scene.
 */
import type { DrawingScene } from "./canvas-core.ts";

/** The drawings route's PNG limit (app/api/chats/[id]/drawings/route.ts). */
export const DRAWING_PNG_MAX_BYTES = 10 * 1024 * 1024;
/** The assets route's image limit (app/api/chats/[id]/drawings/assets/route.ts). */
export const DRAWING_ASSET_MAX_BYTES = 5 * 1024 * 1024;
/** What the client aims for: under both route limits with room for the grid overlay and re-encoding noise. */
export const PHOTO_PNG_BUDGET_BYTES = 9 * 1024 * 1024;
export const PHOTO_ASSET_BUDGET_BYTES = 4 * 1024 * 1024;
/** The long side of the submitted PNG: the canvas export's own cap (the server refuses over 4096 per side). */
export const PHOTO_MAX_SIDE = 2048;
/** Smaller long sides tried, in order, when the PNG at the larger size is over budget. */
const PHOTO_SIDE_LADDER = [2048, 1600, 1280, 1024, 768, 512] as const;

/** Target size for an image whose long side may not exceed `max`; never upscales, keeps the aspect ratio. */
export function fitLongSide(w: number, h: number, max: number): { w: number; h: number } {
	const long = Math.max(w, h);
	if (!(long > max)) return { w, h };
	const k = max / long;
	return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** The long sides to try for a photo of this (already oriented) size: the cap first, then each smaller step. */
export function photoSideLadder(w: number, h: number): number[] {
	const first = Math.min(Math.max(w, h), PHOTO_MAX_SIDE);
	return [first, ...PHOTO_SIDE_LADDER.filter((s) => s < first)];
}

// ---- EXIF orientation ----

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** The EXIF Orientation (tag 0x0112) of a JPEG, read from its first APP1 segment; 1 (upright) when the bytes are
 *  not a JPEG, carry no EXIF, or are malformed. Reads only the header, never the pixels. */
export function readExifOrientation(bytes: Uint8Array): ExifOrientation {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 2;
	while (pos + 4 <= bytes.length) {
		if (bytes[pos] !== 0xff) return 1;
		const marker = bytes[pos + 1]!;
		if (marker === 0xff) {
			pos += 1; // fill byte
			continue;
		}
		if (marker === 0xda || marker === 0xd9) return 1; // image data or end: no EXIF came first
		const len = view.getUint16(pos + 2);
		if (len < 2) return 1;
		if (marker === 0xe1 && len >= 16 && pos + 2 + len <= bytes.length) {
			const exif = readTiffOrientation(view, pos + 4, pos + 2 + len);
			if (exif !== null) return exif;
		}
		pos += 2 + len;
	}
	return 1;
}

/** `start` is the first byte after the APP1 length; `end` is exclusive. null when this APP1 is not EXIF or lacks the tag. */
function readTiffOrientation(view: DataView, start: number, end: number): ExifOrientation | null {
	if (end - start < 14) return null;
	const sig = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
	if (!sig.every((b, i) => view.getUint8(start + i) === b)) return null;
	const tiff = start + 6;
	const order = view.getUint16(tiff);
	if (order !== 0x4949 && order !== 0x4d4d) return null;
	const little = order === 0x4949;
	if (view.getUint16(tiff + 2, little) !== 0x002a) return null;
	const ifd = tiff + view.getUint32(tiff + 4, little);
	if (ifd + 2 > end) return null;
	const count = view.getUint16(ifd, little);
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > end) return null;
		if (view.getUint16(entry, little) !== 0x0112) continue;
		const value = view.getUint16(entry + 8, little);
		return value >= 1 && value <= 8 ? (value as ExifOrientation) : null;
	}
	return null;
}

/** Size of the image once displayed upright: orientations 5 to 8 turn it a quarter, so width and height swap. */
export function orientedSize(w: number, h: number, orientation: ExifOrientation): { w: number; h: number } {
	return orientation >= 5 ? { w: h, h: w } : { w, h };
}

/** The 2D transform [a, b, c, d, e, f] (CanvasRenderingContext2D.setTransform order) that draws a w x h raw image
 *  at (0, 0, w, h) into an upright canvas of orientedSize(w, h, orientation). */
export function orientationTransform(orientation: ExifOrientation, w: number, h: number): [number, number, number, number, number, number] {
	switch (orientation) {
		case 2: return [-1, 0, 0, 1, w, 0];
		case 3: return [-1, 0, 0, -1, w, h];
		case 4: return [1, 0, 0, -1, 0, h];
		case 5: return [0, 1, 1, 0, 0, 0];
		case 6: return [0, 1, -1, 0, h, 0];
		case 7: return [0, -1, -1, 0, h, w];
		case 8: return [0, -1, 1, 0, 0, w];
		default: return [1, 0, 0, 1, 0, 0];
	}
}

// ---- the scene ----

/** The scene of a photo submission: one image object at the origin, at its pixel size (so the PNG export, which
 *  draws one scene unit as one pixel up to the 2048 cap, keeps the photo's resolution). */
export function photoScene(w: number, h: number, assetId: string): DrawingScene {
	return { version: 1, objects: [{ id: "o1", z: 0, type: "image", x: 0, y: 0, w, h, assetId }] };
}

/** A 2x1 JPEG stored with EXIF orientation 6. A browser that applies EXIF decodes it as 1x2; one that does not,
 *  as 2x1 (then components/canvas/photo-prepare.ts applies the transform itself). */
export const EXIF_PROBE_JPEG_BASE64 =
	"/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKwAf//Z";
