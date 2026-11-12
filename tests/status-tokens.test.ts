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
const ALLOWED: { file: string; cls: string; count: number; why: string }[] = [
	// The plan map's current-node glow is a decorative highlight, not a status
	// (themes step 2 checked it on Ivory: still visible, kept).
	{ file: "components/plan-block.tsx", cls: "fill-yellow-400/25", count: 1, why: "decorative glow" },
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

/** Lines look like `file:line:class`; an allowed class is dropped only up to
 *  its counted occurrences, so one allowed class never permits a second. */
function palettePlain(lines: string[]): string[] {
	const used = new Map<string, number>();
	return lines.filter((l) => {
		const m = /^(.*?):\d+:(.*)$/.exec(l);
		const a = m && ALLOWED.find((x) => x.file === m[1] && x.cls === m[2]);
		if (!a) return true;
		const key = `${a.file} ${a.cls}`;
		used.set(key, (used.get(key) ?? 0) + 1);
		return used.get(key)! > a.count;
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

/** Matches allowed to stay, each with how many times it may occur in that
 *  file and why: one allowed literal never permits a second. */
const COLOUR_MATCHES: { file: string; match: string; count: number; why: string }[] = [
	{ file: "components/canvas/canvas-engine.ts", match: "#ffffff", count: 2, why: "the exported PNG is dark ink on white paper on both themes" },
	{ file: "components/canvas/canvas-engine.ts", match: "#1d4ed8", count: 1, why: "export: the object badge on white paper" },
	{ file: "components/canvas/canvas-engine.ts", match: "rgba(", count: 2, why: "export: region grid lines and labels on white paper" },
	{ file: "components/canvas/photo-prepare.ts", match: "#ffffff", count: 2, why: "export: the photo's white paper" },
	{ file: "components/css-color.ts", match: "#888888", count: 2, why: "the fallback when a token cannot be read" },
	{ file: "components/graph-canvas.ts", match: "rgba(", count: 2, why: "the hex + alpha helper" },
	{ file: "components/graph-canvas.ts", match: "hsla(", count: 3, why: "cluster hues; the lightness comes from CLUSTER_LIGHTNESS per mode" },
	{ file: "components/lh-mark.tsx", match: "rgb(", count: 1, why: "the mark's mid-gray spiral reads on both pages (upstream keeps it)" },
	{ file: "components/artifacts/demo-card.tsx", match: "bg-white", count: 1, why: "demos render on white paper, like a page" },
	{ file: "components/artifacts/visual-card.tsx", match: "bg-white", count: 3, why: "figures sit on white paper (the learner's invert toggle flips it)" },
	{ file: "components/session-overlay.tsx", match: "bg-white", count: 1, why: "figures sit on white paper in the overlay too" },
	{ file: "components/work-cards.tsx", match: "bg-white", count: 2, why: "drawing thumbnails are exported light" },
	{ file: "components/settings/users-section.tsx", match: "bg-white", count: 1, why: "a QR code needs a white quiet zone" },
	{ file: "components/composer.tsx", match: "text-white", count: 1, why: "white on the filled success button, both themes" },
	{ file: "components/ui/button.tsx", match: "text-white", count: 1, why: "white on the filled destructive button, both themes" },
	{ file: "components/keyboard-shortcuts.tsx", match: "bg-black", count: 1, why: "the modal scrim" },
	{ file: "components/ui/button.tsx", match: "dark:", count: 7, why: "shadcn's dark tweaks, applied by the theme-aware dark variant" },
	{ file: "components/ui/input.tsx", match: "dark:", count: 2, why: "shadcn's dark tweaks, applied by the theme-aware dark variant" },
	{ file: "components/ai-elements/conversation.tsx", match: "dark:", count: 4, why: "ai-elements' dark tweaks, applied by the theme-aware dark variant" },
	{ file: "components/sidebar.tsx", match: "dark:", count: 1, why: "shadcn's dark hover, applied by the theme-aware dark variant" },
	// Not colours: issue and entity numbers, and colours named in comments.
	{ file: "components/chat.tsx", match: "#110", count: 1, why: "an issue number" },
	{ file: "src/core/input-events.ts", match: "#110", count: 2, why: "an issue number" },
	{ file: "src/core/native-messages.ts", match: "#102", count: 1, why: "an issue number" },
	{ file: "src/core/question-core.ts", match: "#418", count: 1, why: "a React error number" },
	{ file: "src/core/svg-image-source.ts", match: "#160", count: 1, why: "an HTML entity" },
	{ file: "components/md-blocks.tsx", match: "#ee928c", count: 1, why: "a comment about the retired factory ink" },
	{ file: "src/core/learner-colors.ts", match: "#ef4444", count: 1, why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#eab308", count: 1, why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#22c55e", count: 1, why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#8d8d8d", count: 1, why: "the doc comment naming Default's values" },
	{ file: "src/core/learner-colors.ts", match: "#e6e6e6", count: 1, why: "the doc comment naming Default's values" },
];

const COLOUR_PATTERNS = [
	"#[0-9a-fA-F]{3,8}\\b",
	"\\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\\(",
	"\\b(text|bg|border|fill|stroke|ring|from|via|to|outline|divide|decoration|shadow|placeholder|caret|accent)-(white|black)\\b",
	// A Tailwind variant (`dark:bg-…`), not a mode table's key (`dark: {`).
	"\\bdark:[a-z]",
];

/** `file match` → occurrences, from `file:line:match` grep lines. */
function countMatches(lines: string[], normalise: (match: string) => string = (m) => m): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of lines) {
		const m = /^(.*?):\d+:(.*)$/.exec(line);
		const key = m ? `${m[1]} ${normalise(m[2]!)}` : line;
		out.set(key, (out.get(key) ?? 0) + 1);
	}
	return out;
}

describe("hard-coded colours stay in the allowlist (themes step 2)", () => {
	it("no hex / rgb / hsl / oklch, -white / -black class or dark: variant outside it, and never more than it counts", () => {
		const found = COLOUR_PATTERNS.flatMap((p) => grepMatches(p, ["app", "components", "src/core"])).filter((line) => {
			const file = /^(.*?):\d+:/.exec(line)?.[1] ?? "";
			return !COLOUR_FILES.some((f) => file === f.file || (f.file.endsWith("/") && file.startsWith(f.file)));
		});
		const counts = countMatches(found, (m) => (m.startsWith("dark:") ? "dark:" : m));
		const over = [...counts].flatMap(([key, n]) => {
			const allowed = COLOUR_MATCHES.find((a) => `${a.file} ${a.match}` === key)?.count ?? 0;
			return n > allowed ? [`${key}: ${n} found, ${allowed} allowed`] : [];
		});
		assert.deepEqual(over, []);
	});

	it("the allowlist is not stale: every entry still occurs exactly as often as it says", () => {
		const found = COLOUR_PATTERNS.flatMap((p) => grepMatches(p, COLOUR_MATCHES.map((a) => a.file)));
		const counts = countMatches(found, (m) => (m.startsWith("dark:") ? "dark:" : m));
		for (const a of COLOUR_MATCHES) assert.equal(counts.get(`${a.file} ${a.match}`) ?? 0, a.count, `${a.file} ${a.match}`);
	});
});

/** Text kept on an opacity modifier, with count and why (themes step 2: the
 *  rest became per-theme tokens). */
const FADED_TEXT_ALLOWED: { file: string; match: string; count: number; why: string }[] = [
	{ file: "components/graph-context-card.tsx", match: "text-foreground/80", count: 1, why: "5.9:1 on Ivory's page, AA on both themes" },
	{ file: "components/ui/tooltip.tsx", match: "text-foreground/85", count: 1, why: "over 7:1 on Ivory's tooltip surface" },
];

describe("tertiary text uses the per-theme tokens (themes step 2)", () => {
	it("no text-muted-foreground/NN or text-foreground/NN modifier outside the counted allowlist", () => {
		const counts = countMatches(grepMatches("\\b(text|fill|placeholder)-(muted-)?foreground/[0-9]+", ["app", "components"]));
		const over = [...counts].flatMap(([key, n]) => {
			const allowed = FADED_TEXT_ALLOWED.find((a) => `${a.file} ${a.match}` === key)?.count ?? 0;
			return n > allowed ? [`${key}: ${n} found, ${allowed} allowed (use text-muted-foreground-NN / text-foreground-50)`] : [];
		});
		assert.deepEqual(over, []);
	});
});
