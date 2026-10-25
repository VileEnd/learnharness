import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifySwipe, isKeyboardOpen, resolveSidebarOpen, sidebarStorageKey } from "../components/sidebar-state.ts";

describe("sidebar state", () => {
	it("defaults open on wide screens only", () => {
		assert.equal(resolveSidebarOpen(null, true), true);
		assert.equal(resolveSidebarOpen(null, false), false);
	});

	it("desktop restores its stored state; the phone drawer always starts closed", () => {
		assert.equal(resolveSidebarOpen("0", true), false);
		assert.equal(resolveSidebarOpen("1", false), false);
	});

	it("phone and desktop use different keys, desktop's unchanged", () => {
		assert.equal(sidebarStorageKey(true), "lh:sidebar-open");
		assert.notEqual(sidebarStorageKey(false), sidebarStorageKey(true));
	});
});

describe("isKeyboardOpen", () => {
	it("is open when the visual viewport shrank a lot, on touch only", () => {
		assert.equal(isKeyboardOpen(400, 844, true), true);
		assert.equal(isKeyboardOpen(800, 844, true), false);
		assert.equal(isKeyboardOpen(400, 844, false), false);
	});
});

describe("classifySwipe", () => {
	const at = (x: number, y: number) => ({ x, y });

	it("opens on a rightward drag from the left edge", () => {
		assert.equal(classifySwipe(at(5, 300), at(120, 310), false), "open");
	});

	it("ignores rightward drags that start away from the edge", () => {
		assert.equal(classifySwipe(at(80, 300), at(200, 300), false), null);
	});

	it("ignores short or mostly vertical drags", () => {
		assert.equal(classifySwipe(at(5, 300), at(40, 300), false), null);
		assert.equal(classifySwipe(at(5, 300), at(90, 500), false), null);
	});

	it("closes on a leftward drag when open, not when closed", () => {
		assert.equal(classifySwipe(at(250, 300), at(120, 300), true), "close");
		assert.equal(classifySwipe(at(250, 300), at(120, 300), false), null);
	});
});
