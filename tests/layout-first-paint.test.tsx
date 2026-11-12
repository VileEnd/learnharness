/**
 * The REAL root layout (app/layout.tsx), not a hand-built copy: its CSS
 * imports, next/font/google and next/headers are stubbed through Node's module
 * hooks, and everything else loads as the app does. The layout's own output
 * (the element tree it returns, and generateViewport) is checked for each
 * theme choice, so dropping data-theme, a theme-color meta, the status-bar
 * style or the provider's initialAppearance fails here.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

/** The request headers the stubbed next/headers hands the layout. */
const HEADERS_KEY = "__lhLayoutTestHeaders";
(globalThis as Record<string, unknown>)[HEADERS_KEY] = new Headers();

const STUBS: Record<string, string> = {
	"next/font/google": `const face = (name) => () => ({ variable: "font-" + name, className: "font-" + name, style: {} });
export const JetBrains_Mono = face("jetbrains"); export const Source_Sans_3 = face("sans3"); export const Shantell_Sans = face("hand");`,
	"next/headers": `export async function headers() { return globalThis.${HEADERS_KEY}; }`,
};

registerHooks({
	resolve(specifier, context, next) {
		if (specifier in STUBS) return { url: `lh-stub:${specifier}`, shortCircuit: true };
		if (specifier.endsWith(".css")) return { url: "lh-stub:css", shortCircuit: true };
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === "lh-stub:css") return { format: "module", source: "export default {};", shortCircuit: true };
		if (url.startsWith("lh-stub:")) return { format: "module", source: STUBS[url.slice("lh-stub:".length)]!, shortCircuit: true };
		return next(url, context);
	},
});

const layout = await import("../app/layout.tsx");
const { writeSettings } = await import("../src/store/settings.ts");
const { settingsFile } = await import("../config.ts");
const { AppearanceProvider } = await import("../components/settings/appearance.tsx");

type El = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;

/** Every element of a tree, depth first (props.children only: the layout's
 *  own JSX, not what its components would render). */
function elements(node: React.ReactNode): El[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!React.isValidElement(node)) return [];
	const el = node as El;
	return [el, ...elements(el.props.children)];
}

async function paint() {
	const html = (await layout.default({ children: null })) as El;
	const all = elements(html);
	const meta = (name: string) => all.filter((e) => e.type === "meta" && e.props.name === name).map((e) => e.props.content);
	const provider = all.find((e) => e.type === AppearanceProvider);
	return { html, meta, provider, viewport: await layout.generateViewport() };
}

describe("app/layout.tsx renders the learner's theme in the first HTML", () => {
	it("no record: Default", async () => {
		fs.rmSync(settingsFile(), { force: true });
		const { html, meta, provider, viewport } = await paint();
		assert.equal(html.type, "html");
		assert.equal(html.props["data-theme"], "default");
		assert.deepEqual(meta("apple-mobile-web-app-status-bar-style"), ["black-translucent"]);
		assert.ok(provider, "the AppearanceProvider is mounted");
		assert.equal(provider.props.initialAppearance, undefined);
		assert.equal(viewport.themeColor, "#141414");
		assert.equal(viewport.colorScheme, "dark");
	});

	it("Ivory: the attribute, the opaque status bar, the record handed to the provider, the light chrome", async () => {
		writeSettings({ version: 2, appearance: { theme: "ivory", proseFontSize: 18 } });
		const { html, meta, provider, viewport } = await paint();
		assert.equal(html.props["data-theme"], "ivory");
		assert.deepEqual(meta("apple-mobile-web-app-status-bar-style"), ["default"]);
		assert.deepEqual(provider?.props.initialAppearance, { theme: "ivory", proseFontSize: 18 });
		assert.equal(viewport.themeColor, "#faf9f5");
		assert.equal(viewport.colorScheme, "light");
	});

	it("Follow system: a theme-color per device mode, each theme's own background", async () => {
		writeSettings({ version: 2, appearance: { theme: "system", colors: { default: { background: "#202020" } } } });
		const { html, meta, provider, viewport } = await paint();
		assert.equal(html.props["data-theme"], "system");
		assert.deepEqual(meta("apple-mobile-web-app-status-bar-style"), ["default"]);
		assert.deepEqual(provider?.props.initialAppearance, { theme: "system", colors: { default: { background: "#202020" } } });
		assert.deepEqual(viewport.themeColor, [
			{ media: "(prefers-color-scheme: light)", color: "#faf9f5" },
			{ media: "(prefers-color-scheme: dark)", color: "#202020" },
		]);
		assert.equal(viewport.colorScheme, "light dark");
	});

	it("the Apple web-app metas are the layout's own (Next's appleWebApp would add a second style)", async () => {
		const { meta } = await paint();
		assert.deepEqual(meta("mobile-web-app-capable"), ["yes"]);
		assert.deepEqual(meta("apple-mobile-web-app-title"), ["LearnHarness"]);
		assert.equal((layout.metadata as { appleWebApp?: unknown }).appleWebApp, undefined);
	});
});
