/**
 * The surfaces that assumed a dark page (port of upstream's
 * tests/light-surfaces.test.tsx, 4117f212, plus the fork-only surfaces of
 * themes step 2): each now reads the theme tokens or the rendered mode.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { confidenceRailStyle } from "../components/confidence-rail.tsx";
import { mermaidConfig } from "../components/mermaid-render.ts";
import { CLUSTER_LIGHTNESS } from "../components/graph-canvas.ts";
import { LhMark } from "../components/lh-mark.tsx";
import { CATEGORY_COLORS, CATEGORY_ORDER } from "../components/usage/charts.tsx";
import { themeColorFor } from "../components/settings/appearance.tsx";
import { LEARNER_DUE_RING, LEARNER_STATE_STYLES, learnerNodeStyle } from "../src/core";

describe("confidence rail", () => {
	it("sits on the page background, ticks in the text ink", () => {
		const style = confidenceRailStyle(50);
		assert.equal(style.backgroundColor, "var(--background)");
		const tick = "color-mix(in oklab, var(--foreground) 35%, transparent)";
		assert.ok(String(style.backgroundImage).includes(`linear-gradient(90deg, ${tick}, ${tick})`));
		assert.ok(!String(style.backgroundImage).includes("rgba(230,230,230"));
	});
});

describe("mermaid", () => {
	it("dark mode renders mermaid's dark theme, light its default", () => {
		assert.equal(mermaidConfig("dark").theme, "dark");
		assert.equal(mermaidConfig("light").theme, "default");
		assert.equal(mermaidConfig("light").securityLevel, "strict");
	});
});

describe("graph clusters", () => {
	it("dark keeps today's lightness; light darkens rings and labels", () => {
		assert.deepEqual(CLUSTER_LIGHTNESS.dark, { ring: 60, label: 78 });
		assert.ok(CLUSTER_LIGHTNESS.light.ring < CLUSTER_LIGHTNESS.dark.ring);
		assert.ok(CLUSTER_LIGHTNESS.light.label < CLUSTER_LIGHTNESS.dark.label);
	});
});

describe("strong line ink (white in Default, the text colour in Ivory)", () => {
	it("LH mark: the ring follows the token; the spiral gray stays", () => {
		const html = renderToStaticMarkup(<LhMark />);
		assert.equal((html.match(/fill:var\(--lh-line-strong\)/g) ?? []).length, 2);
		assert.ok(!html.includes("#fff"));
		assert.ok(html.includes("rgb(148,148,148)"));
	});

	// The plan map and the markdown callout: tests/render-plan-block.test.tsx
	// and tests/render-md-blocks.test.tsx pin stroke-line-strong / border-line-strong.
});

describe("learner colours are theme tokens", () => {
	it("every state and the due ring is a CSS variable the theme sets", () => {
		for (const s of Object.values(LEARNER_STATE_STYLES)) assert.equal(s.color, `var(${s.cssVar})`);
		assert.equal(LEARNER_DUE_RING.color, "var(--lh-learner-due)");
	});

	it("the canvases resolve the variable to a colour; the DOM keeps the variable", () => {
		const resolve = (v: string) => `hex(${v})`;
		assert.deepEqual(learnerNodeStyle({ state: "shaky", due: true }, resolve), { color: "hex(--lh-learner-shaky)", due: true });
		assert.deepEqual(learnerNodeStyle(undefined), { color: "var(--lh-learner-unchecked)", due: false });
	});
});

describe("usage charts", () => {
	it("one validated set per mode, same hue order, the light set darker", () => {
		const lum = (hex: string) => {
			const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
			return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
		};
		for (const c of CATEGORY_ORDER) {
			assert.ok(lum(CATEGORY_COLORS.light[c]) < lum(CATEGORY_COLORS.dark[c]), c);
		}
		assert.equal(CATEGORY_COLORS.dark.teaching, "#3987e5", "the dark set is unchanged");
	});
});

describe("browser chrome", () => {
	it("each theme-color meta takes the colour of its media query, or of the mode on screen", () => {
		const chrome = { light: "#faf9f5", dark: "#141414" };
		assert.equal(themeColorFor("(prefers-color-scheme: light)", chrome, "dark"), "#faf9f5");
		assert.equal(themeColorFor("(prefers-color-scheme: dark)", chrome, "light"), "#141414");
		assert.equal(themeColorFor("", chrome, "light"), "#faf9f5");
	});
});
