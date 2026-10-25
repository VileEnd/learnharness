/**
 * Pure decisions behind the phone work (PR C): Return on touch, the keyboard
 * viewport, the back-gesture entry stack, pinch zoom and the download route.
 * No DOM — each lives as a pure function exactly so this can pin it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enterSends } from "../components/enter-submits.ts";
import { keyboardViewportHeight } from "../components/use-visual-viewport.ts";
import { popEntries } from "../components/use-back-dismiss.ts";
import { fitZoomFor, pinchView, ZOOM_MAX } from "../components/pan-zoom.ts";
import { pickDownloadRoute } from "../components/artifacts/download.ts";

const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
	key: k,
	shiftKey: false,
	metaKey: false,
	ctrlKey: false,
	...mods,
});

describe("enterSends", () => {
	it("desktop: Enter sends, Shift+Enter is a newline, Cmd/Ctrl+Enter sends", () => {
		assert.equal(enterSends(key("Enter"), false), true);
		assert.equal(enterSends(key("Enter", { shiftKey: true }), false), false);
		assert.equal(enterSends(key("Enter", { metaKey: true }), false), true);
		assert.equal(enterSends(key("Enter", { ctrlKey: true, shiftKey: true }), false), true);
	});

	it("touch: Return is always a newline; only the chord (hardware keyboard) sends", () => {
		assert.equal(enterSends(key("Enter"), true), false);
		assert.equal(enterSends(key("Enter", { shiftKey: true }), true), false);
		assert.equal(enterSends(key("Enter", { metaKey: true }), true), true);
	});

	it("other keys never send", () => {
		assert.equal(enterSends(key("a"), false), false);
	});
});

describe("keyboardViewportHeight", () => {
	it("returns the visible height only while the touch keyboard is up", () => {
		assert.equal(keyboardViewportHeight(400.4, 800, true), 400);
		assert.equal(keyboardViewportHeight(780, 800, true), null);
		assert.equal(keyboardViewportHeight(400, 800, false), null); // a small desktop window
	});
});

describe("popEntries (back-gesture history mirror)", () => {
	it("popping to an earlier tagged entry drops everything above it, top first", () => {
		assert.deepEqual(popEntries([1, 2, 3], 1), { entries: [1], popped: [3, 2] });
	});

	it("popping to a page that is not ours drops all entries", () => {
		assert.deepEqual(popEntries([1, 2], null), { entries: [], popped: [2, 1] });
	});

	it("staying on the top entry or landing on an unknown tag changes nothing", () => {
		assert.deepEqual(popEntries([1, 2], 2), { entries: [1, 2], popped: [] });
		assert.deepEqual(popEntries([1, 2], 9), { entries: [1, 2], popped: [] });
	});
});

describe("pinchView", () => {
	const box = { w: 1000, h: 800 };
	const vp = { w: 400, h: 600 };
	const floor = fitZoomFor(box, vp);
	const view = { zoom: floor * 2, x: -100, y: -50 };

	it("spreading the fingers zooms in around the midpoint", () => {
		const prev = [{ x: 150, y: 300 }, { x: 250, y: 300 }] as const;
		const next = [{ x: 100, y: 300 }, { x: 300, y: 300 }] as const;
		const out = pinchView(view, prev, next, floor, box, vp);
		assert.ok(Math.abs(out.zoom - view.zoom * 2) < 1e-9, "distance doubled, zoom doubled");
		// the content point under the old midpoint stays under the new one
		const before = (200 - view.x) / view.zoom;
		const after = (200 - out.x) / out.zoom;
		assert.ok(Math.abs(before - after) < 1e-6);
	});

	it("pinching in past the fit floor re-fits and never pans", () => {
		const prev = [{ x: 100, y: 300 }, { x: 300, y: 300 }] as const;
		const next = [{ x: 190, y: 300 }, { x: 210, y: 300 }] as const;
		const out = pinchView(view, prev, next, floor, box, vp);
		assert.equal(out.zoom, floor);
	});

	it("zoom is capped at ZOOM_MAX", () => {
		const prev = [{ x: 190, y: 300 }, { x: 210, y: 300 }] as const;
		const next = [{ x: 0, y: 300 }, { x: 400, y: 300 }] as const;
		assert.equal(pinchView(view, prev, next, floor, box, vp).zoom, ZOOM_MAX);
	});

	it("moving both fingers together pans", () => {
		const prev = [{ x: 150, y: 300 }, { x: 250, y: 300 }] as const;
		const next = [{ x: 170, y: 320 }, { x: 270, y: 320 }] as const;
		const out = pinchView(view, prev, next, floor, box, vp);
		assert.equal(out.zoom, view.zoom);
		assert.equal(out.x, view.x + 20);
		assert.equal(out.y, view.y + 20);
	});
});

describe("pickDownloadRoute", () => {
	it("shares files on touch devices that can; the anchor everywhere else", () => {
		assert.equal(pickDownloadRoute(true, true), "share");
		assert.equal(pickDownloadRoute(true, false), "anchor");
		assert.equal(pickDownloadRoute(false, true), "anchor");
	});
});
