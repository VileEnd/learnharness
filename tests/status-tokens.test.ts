/**
 * The status-colour law (themes step 1): error / success / warning chrome
 * uses the theme tokens (text-error, bg-success/15, border-warning/50, …),
 * never a fixed Tailwind palette class, which would ignore the active theme.
 * Port of upstream's tests/status-tokens.test.ts, with yellow and emerald
 * added and one named allowlist entry.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

// Deliberately left (not a status): the plan map's current-node glow is a
// decorative yellow highlight; it belongs to step 3 (light-mode fixes).
const ALLOWED = [{ file: "components/plan-block.tsx", text: "fill-yellow-400/25" }];

const PATTERN = "\\b(text|bg|border|fill|stroke|ring|from|via|to|outline|divide|decoration|shadow)-(red|green|amber|emerald|yellow)-[0-9]{2,3}";

describe("status colours are theme tokens", () => {
	it("no red/green/amber/emerald/yellow palette class is left under components/ or app/", () => {
		let out = "";
		try {
			out = execFileSync("git", ["grep", "--untracked", "-n", "-E", PATTERN, "--", "components", "app"], {
				cwd: new URL("..", import.meta.url),
				encoding: "utf8",
			}).trim();
		} catch (e) {
			// git grep exits 1 when nothing matches: the passing case.
			if ((e as { status?: number }).status !== 1) throw e;
		}
		const left = out
			.split("\n")
			.filter((l) => l && !ALLOWED.some((a) => l.startsWith(`${a.file}:`) && l.includes(a.text)));
		assert.deepEqual(left, []);
	});
});
