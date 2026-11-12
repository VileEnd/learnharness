/**
 * The status-colour law (themes step 1): error / success / warning chrome
 * uses the theme tokens (text-error, bg-success/15, border-warning/50, ...),
 * never a fixed Tailwind palette class, which would ignore the active theme.
 * Port of upstream's tests/status-tokens.test.ts, widened.
 *
 * Themes step 2 adds the hard-coded colour law: no hex / rgb / hsl / oklch
 * literal, no -white / -black class and no `dark:` variant under app/,
 * components/ or src/core/ outside the allowlist below, where each entry
 * says why that colour may stay fixed on both themes.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

// Exact classes deliberately left, each with the file that holds it.
const ALLOWED: { file: string; cls: string; why: string }[] = [
	// The plan map's current-node glow is a decorative highlight, not a status
	// (themes step 2 checked it on Ivory: still visible, kept).
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

// ── themes step 2: the hard-coded colour law ────────────────────────────────

/** Whole files that ARE palettes (their colours are the point), with why. */
const COLOUR_FILES: { file: string; why: string }[] = [
	{ file: "src/core/themes.ts", why: "the two presets: the source of every theme colour" },
	{ file: "app/globals.css", why: "both palettes as literals for the first frame (pinned to themes.ts)" },
	{ file: "src/core/okf-viz/", why: "the vendored OKF viewer: a standalone export file with its own light design" },
	{ file: "src/core/okf-viz.ts", why: "the OKF viewer's node-type colours, on that viewer's own light page" },
	{ file: "components/canvas/geometry.ts", why: "the pen palette, a light and a dark set picked by the rendered mode" },
	{ file: "components/usage/charts.tsx", why: "the validated chart palettes, a light and a dark set" },
	{ file: "components/confidence-rail.tsx", why: "the confidence ramp: saturated fills that read on both pages" },
	{ file: "app/icon.svg", why: "the app icon" },
];

/** Single matches allowed to stay, each with why. */
const COLOUR_MATCHES: { file: string; match: string; why: string }[] = [
	{ file: "components/canvas/canvas-engine.ts", match: "#ffffff", why: "the exported PNG is dark ink on white paper on both themes" },
	{ file: "components/canvas/canvas-engine.ts", match: "#1d4ed8", why: "export: the object badge on white paper" },
	{ file: "components/canvas/canvas-engine.ts", match: "rgba(", why: "export: region grid lines and labels on white paper" },
	{ file: "components/canvas/photo-prepare.ts", match: "#ffffff", why: "export: the photo's white paper" },
	{ file: "components/css-color.ts", match: "#888888", why: "the fallback when a token cannot be read" },
	{ file: "components/graph-canvas.ts", match: "rgba(", why: "the hex + alpha helper" },
	{ file: "components/graph-canvas.ts", match: "hsla(", why: "cluster hues; the lightness comes from CLUSTER_LIGHTNESS per mode" },
	{ file: "components/lh-mark.tsx", match: "rgb(", why: "the mark's mid-gray spiral reads on both pages (upstream keeps it)" },
	{ file: "components/artifacts/demo-card.tsx", match: "bg-white", why: "demos render on white paper, like a page" },
	{ file: "components/artifacts/visual-card.tsx", match: "bg-white", why: "figures sit on white paper (the learner's invert toggle flips it)" },
	{ file: "components/session-overlay.tsx", match: "bg-white", why: "figures sit on white paper in the overlay too" },
	{ file: "components/work-cards.tsx", match: "bg-white", why: "drawing thumbnails are exported light" },
	{ file: "components/settings/users-section.tsx", match: "bg-white", why: "a QR code needs a white quiet zone" },
	{ file: "components/composer.tsx", match: "text-white", why: "white on the filled success button, both themes" },
	{ file: "components/ui/button.tsx", match: "text-white", why: "white on the filled destructive button, both themes" },
	{ file: "components/keyboard-shortcuts.tsx", match: "bg-black", why: "the modal scrim" },
	{ file: "components/ui/button.tsx", match: "dark:", why: "shadcn's dark tweaks, applied by the theme-aware dark variant" },
	{ file: "components/ui/input.tsx", match: "dark:", why: "shadcn's dark tweaks, applied by the theme-aware dark variant" },
	{ file: "components/ai-elements/conversation.tsx", match: "dark:", why: "ai-elements' dark tweaks, applied by the theme-aware dark variant" },
	{ file: "components/sidebar.tsx", match: "dark:", why: "shadcn's dark hover, applied by the theme-aware dark variant" },
	// Not colours: issue and entity numbers, and colours named in comments.
	{ file: "components/chat.tsx", match: "#110", why: "an issue number" },
	{ file: "src/core/input-events.ts", match: "#110", why: "an issue number" },
	{ file: "src/core/native-messages.ts", match: "#102", why: "an issue number" },
	{ file: "src/core/question-core.ts", match: "#418", why: "a React error number" },
	{ file: "src/core/svg-image-source.ts", match: "#160", why: "an HTML entity" },
	{ file: "components/md-blocks.tsx", match: "#ee928c", why: "a comment about the retired factory ink" },
	{ file: "src/core/learner-colors.ts", match: "#ef4444", why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#eab308", why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#22c55e", why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#8d8d8d", why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#e6e6e6", why: "the doc comment naming Default's values" },
];

const COLOUR_PATTERNS = [
	"#[0-9a-fA-F]{3,8}\\b",
	"\\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\\(",
	"\\b(text|bg|border|fill|stroke|ring|from|via|to|outline|divide|decoration|shadow|placeholder|caret|accent)-(white|black)\\b",
	// A Tailwind variant (`dark:bg-…`), not a mode table's key (`dark: {`).
	"\\bdark:[a-z]",
];

describe("hard-coded colours stay in the allowlist (themes step 2)", () => {
	it("no hex / rgb / hsl / oklch, -white / -black class or dark: variant outside it", () => {
		const found = COLOUR_PATTERNS.flatMap((p) => grepMatches(p, ["app", "components", "src/core"]));
		const left = found.filter((line) => {
			const m = /^(.*?):\d+:(.*)$/.exec(line);
			if (!m) return true;
			const [, file, match] = m as unknown as [string, string, string];
			if (COLOUR_FILES.some((f) => file === f.file || (f.file.endsWith("/") && file.startsWith(f.file)))) return false;
			return !COLOUR_MATCHES.some((a) => a.file === file && (a.match === match || (a.match === "dark:" && match.startsWith("dark:"))));
		});
		assert.deepEqual(left, []);
	});
});
