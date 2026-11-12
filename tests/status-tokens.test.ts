/**
 * The status-colour law (themes step 1): error / success / warning chrome
 * uses the theme tokens (text-error, bg-success/15, border-warning/50, ...),
 * never a fixed Tailwind palette class, which would ignore the active theme.
 * Port of upstream's tests/status-tokens.test.ts, widened.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

// Exact classes deliberately left, each with the file that holds it.
const ALLOWED: { file: string; cls: string; why: string }[] = [
	// The plan map's current-node glow is a decorative highlight, not a status; step 3.
	{ file: "components/plan-block.tsx", cls: "fill-yellow-400/25", why: "decorative glow" },
];
// Files allowed to hold arbitrary colour values (non-status colours). None today.
const ARBITRARY_ALLOWED: { file: string; why: string }[] = [];

const PALETTE =
	"\\b(text|bg|border|fill|stroke|ring|ring-offset|from|via|to|outline|divide|decoration|shadow|placeholder|caret|accent)-(red|rose|green|emerald|lime|teal|amber|yellow|orange)-[0-9]{2,3}(/[0-9]+)?";
const ARBITRARY = "-\\[(#|rgb|hsl|oklch|lab)";

/** `file:class` lines for every match; git grep exits 1 when nothing matches. */
function grepMatches(pattern: string, pathspec: string[]): string[] {
	try {
		return execFileSync("git", ["grep", "--untracked", "-o", "-n", "-E", "-e", pattern, "--", ...pathspec], {
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch (e) {
		if ((e as { status?: number }).status !== 1) throw e;
		return [];
	}
}

/** Lines look like `file:line:class`. */
function palettePlain(lines: string[]): string[] {
	return lines.filter((l) => {
		const m = /^(.*?):\d+:(.*)$/.exec(l);
		return !(m && ALLOWED.some((a) => a.file === m[1] && a.cls === m[2]));
	});
}

describe("status colours are theme tokens", () => {
	it("no red/rose/green/emerald/lime/teal/amber/yellow/orange palette class is left under components/ or app/", () => {
		assert.deepEqual(palettePlain(grepMatches(PALETTE, ["components", "app"])), []);
	});

	it("no arbitrary colour value in a .tsx file under components/ or app/", () => {
		const left = grepMatches(ARBITRARY, ["components/*.tsx", "app/*.tsx"]).filter(
			(l) => !ARBITRARY_ALLOWED.some((a) => l.startsWith(`${a.file}:`)),
		);
		assert.deepEqual(left, []);
	});
});
