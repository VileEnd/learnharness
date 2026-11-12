/**
 * Themes step 2 (port of upstream's tests/themes.test.ts, adapted): the two
 * presets, the adapter to the CSS variables, the overrides, the stylesheet
 * the provider renders, and the palettes app/globals.css carries for the
 * first frame.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
	appearanceCss,
	BUILTIN_THEMES,
	chromeColors,
	colorSchemeOf,
	cssString,
	DEFAULT_THEME,
	effectiveColors,
	IVORY_THEME,
	renderedModeOf,
	statusBarStyleOf,
	themeChoiceOf,
	themeColorMeta,
	themeVars,
} from "../src/core";
import { clearColorOverrides, composeColorOverride } from "../components/settings/appearance-section.tsx";

/** The pre-theme palette, as app/globals.css carried it on :root (and .dark)
 *  before themes: every variable that existed then must keep its value. */
const PRE_THEME_DARK: Record<string, string> = {
	"--background": "#141414",
	"--foreground": "#e6e6e6",
	"--card": "#1c1c1c",
	"--card-foreground": "#e6e6e6",
	"--popover": "#1c1c1c",
	"--popover-foreground": "#e6e6e6",
	"--primary": "#e6e6e6",
	"--primary-foreground": "#141414",
	"--secondary": "#1c1c1c",
	"--secondary-foreground": "#e6e6e6",
	"--muted": "#1c1c1c",
	"--muted-foreground": "#8d8d8d",
	"--accent": "#2a2a2a",
	"--accent-foreground": "#e6e6e6",
	"--destructive": "oklch(0.704 0.191 22.216)",
	"--border": "#434343",
	"--input": "#434343",
	"--ring": "#8d8d8d",
	"--lh-error": "oklch(0.637 0.237 25.331)",
	"--lh-success": "oklch(0.723 0.219 149.579)",
	"--lh-success-strong": "oklch(0.627 0.194 149.214)",
	"--lh-warning": "oklch(0.769 0.188 70.08)",
	// var(--foreground) before; the same colour.
	"--lh-ink-strong": "#e6e6e6",
	"--lh-ink-italic": "#e6e6e6",
	// Hard-coded before, tokens now: the white plan/callout/mark ink, the
	// learner-state hexes, and inline code inheriting its text colour.
	"--lh-line-strong": "#ffffff",
	"--lh-learner-shaky": "#ef4444",
	"--lh-learner-learning": "#eab308",
	"--lh-learner-solid": "#22c55e",
	"--lh-ink-code": "currentColor",
};

/** Upstream's Ivory preset (src/core/themes.ts, 356029a8), verbatim. */
const UPSTREAM_IVORY = {
	background: "#faf9f5", surface: "#f0eee6", border: "#e0ddd2", text: "#3d3d3a", textMuted: "#83827d",
	accent: "#d97757", bold: "#3266c9", italic: "#3f8f6b", code: "#c4613f",
	error: "#c43d3d", success: "#3f8f6b", warning: "#b8822a",
};

/** `--name: value;` declarations of one CSS block (comments stripped). */
function declarations(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
	return out;
}

/** The body of the first block that opens with `head {` (brace-matched). */
function blockAfter(css: string, head: string): string {
	const start = css.indexOf(`${head} {`);
	assert.ok(start >= 0, `block ${head} present`);
	let depth = 0;
	for (let i = css.indexOf("{", start); i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
	}
	throw new Error(`unclosed ${head}`);
}

const GLOBALS = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("presets", () => {
	it("two presets only: Default (dark) and Ivory (light)", () => {
		assert.deepEqual(
			BUILTIN_THEMES.map((t) => [t.id, t.name, t.mode]),
			[["default", "Default", "dark"], ["ivory", "Ivory", "light"]],
		);
	});

	it("Default reproduces the pre-theme palette value for value", () => {
		const vars = themeVars(DEFAULT_THEME);
		for (const [name, value] of Object.entries(PRE_THEME_DARK)) assert.equal(vars[name], value, name);
	});

	it("Ivory is upstream's preset", () => {
		assert.deepEqual(IVORY_THEME.colors, UPSTREAM_IVORY);
	});

	it("each step 1 token has a value per theme", () => {
		for (const theme of BUILTIN_THEMES) {
			const vars = themeVars(theme);
			for (const name of ["--lh-error", "--lh-success", "--lh-warning", "--lh-success-strong", "--destructive"]) {
				assert.ok(vars[name], `${theme.id} ${name}`);
			}
		}
	});
});

describe("app/globals.css carries both palettes for the first frame", () => {
	it(":root is themeVars(Default)", () => {
		const root = declarations(blockAfter(GLOBALS, ":root"));
		for (const [name, value] of Object.entries(themeVars(DEFAULT_THEME))) assert.equal(root[name], value, name);
	});

	it('[data-theme="ivory"] and, under prefers-color-scheme: light, [data-theme="system"] are themeVars(Ivory)', () => {
		const ivory = declarations(blockAfter(GLOBALS, ':root[data-theme="ivory"]'));
		const media = blockAfter(GLOBALS, "@media (prefers-color-scheme: light)");
		const system = declarations(blockAfter(media, ':root[data-theme="system"]'));
		for (const [name, value] of Object.entries(themeVars(IVORY_THEME))) {
			assert.equal(ivory[name], value, `ivory ${name}`);
			assert.equal(system[name], value, `system ${name}`);
		}
		assert.deepEqual(system, ivory, "the two light blocks are the same block");
	});

	it("the dark variant follows the theme, not a class", () => {
		assert.ok(!GLOBALS.includes(".dark *"), "no .dark class selector left");
		assert.match(GLOBALS, /&:is\(\[data-theme="default"\] \*\)/);
		assert.match(GLOBALS, /@media not all and \(prefers-color-scheme: light\) \{\s*&:is\(\[data-theme="system"\] \*\)/);
	});
});

describe("the choice", () => {
	it("absent or unknown = default; system resolves against the device", () => {
		assert.equal(themeChoiceOf(undefined), "default");
		assert.equal(themeChoiceOf({ theme: "sepia" as never }), "default");
		assert.equal(renderedModeOf("default", "light"), "dark");
		assert.equal(renderedModeOf("ivory", "dark"), "light");
		assert.equal(renderedModeOf("system", "light"), "light");
		assert.equal(renderedModeOf("system", "dark"), "dark");
	});

	it("browser chrome: one colour for a preset, a light and a dark one for system", () => {
		assert.equal(themeColorMeta(undefined), "#141414");
		assert.equal(themeColorMeta({ theme: "ivory" }), "#faf9f5");
		assert.deepEqual(themeColorMeta({ theme: "system" }), [
			{ media: "(prefers-color-scheme: light)", color: "#faf9f5" },
			{ media: "(prefers-color-scheme: dark)", color: "#141414" },
		]);
		assert.deepEqual(chromeColors({ theme: "system", background: "#202020" }), { light: "#202020", dark: "#202020" });
		assert.deepEqual([colorSchemeOf("default"), colorSchemeOf("ivory"), colorSchemeOf("system")], ["dark", "light", "light dark"]);
	});

	it("iOS status bar: Default keeps black-translucent, a light-capable choice asks for the opaque default", () => {
		assert.deepEqual(
			[statusBarStyleOf("default"), statusBarStyleOf("ivory"), statusBarStyleOf("system")],
			["black-translucent", "default", "default"],
		);
	});
});

describe("overrides", () => {
	it("both homes merge onto the theme, invalid values are ignored", () => {
		const c = effectiveColors(IVORY_THEME, {
			background: "#101010",
			colors: { accent: "#00ff00", warning: "nope", error: null },
			mdRendering: { boldColor: "#ff0000" },
		});
		assert.equal(c.background, "#101010");
		assert.equal(c.accent, "#00ff00");
		assert.equal(c.bold, "#ff0000");
		assert.equal(c.warning, IVORY_THEME.colors.warning);
		assert.equal(c.error, IVORY_THEME.colors.error);
	});

	it("an override is kept across a theme switch: it applies to whichever preset shows", () => {
		const appearance = { colors: { accent: "#123456" } };
		assert.equal(themeVars(DEFAULT_THEME, appearance)["--ring"], "#123456");
		assert.equal(themeVars(IVORY_THEME, appearance)["--ring"], "#123456");
	});

	it("the hover surface steps lighter on dark and darker on light", () => {
		const appearance = { colors: { surface: "#808080" } };
		assert.equal(themeVars(DEFAULT_THEME, appearance)["--accent"], "#8e8e8e");
		assert.equal(themeVars(IVORY_THEME, appearance)["--accent"], "#727272");
	});

	it("--destructive and --lh-success-strong follow an error / success override", () => {
		assert.equal(themeVars(DEFAULT_THEME)["--destructive"], "oklch(0.704 0.191 22.216)");
		const vars = themeVars(DEFAULT_THEME, { colors: { error: "#aa0000", success: "#00aa00" } });
		assert.equal(vars["--destructive"], "#aa0000");
		assert.equal(vars["--lh-error"], "#aa0000");
		assert.equal(vars["--lh-success-strong"], "#00aa00");
	});

	it("the Settings compose helpers write the right home and Reset all clears every colour", () => {
		let a = composeColorOverride({ theme: "ivory", proseFontSize: 18 }, "background", "#111111");
		a = composeColorOverride(a, "bold", "#222222");
		a = composeColorOverride(a, "accent", "#333333");
		assert.deepEqual(a, {
			theme: "ivory",
			proseFontSize: 18,
			background: "#111111",
			mdRendering: { boldColor: "#222222" },
			colors: { accent: "#333333" },
		});
		assert.deepEqual(composeColorOverride(a, "accent", "").colors, {}, "empty = back to the theme's");
		assert.deepEqual(clearColorOverrides(a), { theme: "ivory", proseFontSize: 18, mdRendering: {} });
	});
});

describe("appearanceCss — the provider's <style>", () => {
	it("no override: the type knobs only, the globals.css palettes stand", () => {
		assert.equal(appearanceCss(undefined), "html:root{--lh-prose-size:16px;--lh-heading-weight:900;}");
		assert.equal(appearanceCss({ theme: "ivory" }), appearanceCss(undefined), "the choice is the attribute, not CSS");
	});

	it("an override: both full palettes, one selector step above globals.css, Ivory again for system in light", () => {
		const css = appearanceCss({ colors: { accent: "#123456" } });
		const lines = css.split("\n");
		assert.equal(lines.length, 4);
		assert.match(lines[1]!, /^html:root:not\(\[data-theme="ivory"\]\)\{--background:#141414;.*--ring:#123456;/);
		assert.match(lines[2]!, /^html:root\[data-theme="ivory"\]\{--background:#faf9f5;.*--ring:#123456;/);
		assert.equal(lines[3], `@media (prefers-color-scheme: light){${lines[2]!.replace('"ivory"', '"system"')}}`);
	});

	it("an override equal to an Ivory colour still emits the light rule (the dark rule also matches system)", () => {
		const css = appearanceCss({ background: "#faf9f5" });
		assert.match(css, /html:root\[data-theme="system"\]/);
	});

	it("Reset all removes every colour rule", () => {
		const a = { proseFontSize: 18, background: "#101010", colors: { accent: "#123456" } };
		assert.equal(appearanceCss(clearColorOverrides(a)), "html:root{--lh-prose-size:18px;--lh-heading-weight:900;}");
	});

	it("a font name can never end the rule or the element", () => {
		const css = appearanceCss({ fontFamily: 'Evil"};</style><script>x()</script>' });
		assert.ok(!css.includes("</style"), "no closing tag");
		assert.equal(cssString('a"b\\c<d'), '"a\\"b\\\\c\\3c d"');
		assert.ok(
			css.includes(String.raw`--font-prose:"Evil\"};\3c /style>\3c script>x()\3c /script>", var(--font-sans3)`),
			"the whole name stays inside one CSS string",
		);
	});
});
