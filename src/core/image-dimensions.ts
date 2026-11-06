/**
 * Header-only PNG geometry check. An upload is judged from its IHDR chunk
 * BEFORE anything decodes it: a tiny, highly compressible PNG can declare
 * dimensions whose decode (Photon WASM, twice per turn) allocates gigabytes.
 *
 * The limit is 4096 px per side (= 16.7 MP at most). The real client exports
 * drawings at no more than 2048 px on the long side
 * (components/canvas/canvas-engine.ts), so this is 2x headroom, never reached
 * by a legitimate upload.
 */
export const MAX_PNG_SIDE = 4096;

export type PngDimensions = { ok: true; width: number; height: number } | { ok: false; error: string };

/** Read width/height from the IHDR chunk (bytes 16-23) without decoding. */
export function checkPngDimensions(bytes: Uint8Array): PngDimensions {
	// 8 signature bytes, 4 length, 4 "IHDR", then width and height (u32 BE).
	const isIhdr = bytes.length >= 24 && [0x49, 0x48, 0x44, 0x52].every((b, i) => bytes[12 + i] === b);
	if (!isIhdr) return { ok: false, error: "png header is incomplete" };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (width === 0 || height === 0) return { ok: false, error: "png has invalid dimensions" };
	if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) {
		return { ok: false, error: `png is ${width}x${height}; the maximum is ${MAX_PNG_SIDE} pixels per side` };
	}
	return { ok: true, width, height };
}
