import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchRepaintTriggers } from "../components/canvas/repaint-triggers.ts";

// The wiring CanvasEngine uses to repaint after a restored 2D context and a
// devicePixelRatio change. linkedom has no real 2D context or layout, so the
// decision logic is tested here with plain EventTargets; real context loss is
// only observable in a browser.
describe("canvas repaint triggers", () => {
	it("repaints on contextrestored and re-arms the density query on every change", () => {
		const canvases = [new EventTarget(), new EventTarget()];
		const queries = new Map<string, EventTarget>();
		let dpr = 1;
		const env = { dpr: () => dpr, matchMedia: (q: string) => { const t = new EventTarget(); queries.set(q, t); return t; } };
		let restored = 0, density = 0;
		const dispose = watchRepaintTriggers(canvases, env, () => restored++, () => density++);

		canvases[1]!.dispatchEvent(new Event("contextrestored"));
		assert.equal(restored, 1);

		dpr = 2;
		queries.get("(resolution: 1dppx)")!.dispatchEvent(new Event("change"));
		assert.equal(density, 1);
		dpr = 1.5;
		queries.get("(resolution: 2dppx)")!.dispatchEvent(new Event("change"));
		assert.equal(density, 2);
		assert.ok(queries.has("(resolution: 1.5dppx)"));

		dispose();
		canvases[0]!.dispatchEvent(new Event("contextrestored"));
		queries.get("(resolution: 1.5dppx)")!.dispatchEvent(new Event("change"));
		assert.deepEqual([restored, density], [1, 2]);
	});
});
