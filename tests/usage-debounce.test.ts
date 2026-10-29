import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { debounced } from "../components/usage/debounced.ts";

describe("debounced", () => {
	it("N rapid triggers run once, after the last", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			let runs = 0;
			const d = debounced(() => runs++, 400);
			for (let i = 0; i < 5; i++) {
				d.trigger();
				mock.timers.tick(100);
			}
			assert.equal(runs, 0);
			mock.timers.tick(400);
			assert.equal(runs, 1);
			d.trigger();
			d.cancel();
			mock.timers.tick(1000);
			assert.equal(runs, 1);
		} finally {
			mock.timers.reset();
		}
	});
});
