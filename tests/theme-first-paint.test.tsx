/**
 * The first frame (themes step 2): the record → bootAppearanceFor (what
 * app/layout.tsx reads, in the request's tenant scope) → the markup the
 * layout and the appearance provider send. The layout itself imports CSS and
 * next/font, so it cannot load under tsx; this renders the same pieces in the
 * same shape: <html data-theme>, the theme-color / color-scheme / iOS status
 * bar metas (the layout puts them in <head>), and the provider's <style>.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { colorSchemeOf, statusBarStyleOf, themeChoiceOf, themeColorMeta, type AppearanceSettings } from "../src/core";

const { bootAppearanceFor } = await import("../src/server/theme-boot.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { settingsFile } = await import("../config.ts");
const { AppearanceProvider } = await import("../components/settings/appearance.tsx");

/** What app/layout.tsx renders for this appearance. */
function firstPaint(appearance: AppearanceSettings | undefined): string {
	const choice = themeChoiceOf(appearance);
	const tc = themeColorMeta(appearance);
	return renderToStaticMarkup(
		<html data-theme={choice}>
			<>
				{(typeof tc === "string" ? [{ media: undefined, color: tc }] : tc).map((m) => (
					<meta key={m.color + (m.media ?? "")} name="theme-color" media={m.media} content={m.color} />
				))}
				<meta name="color-scheme" content={colorSchemeOf(choice)} />
				<meta name="apple-mobile-web-app-status-bar-style" content={statusBarStyleOf(choice)} />
			</>
			<body>
				<AppearanceProvider initialAppearance={appearance}>
					<main />
				</AppearanceProvider>
			</body>
		</html>,
	);
}

const single = () => firstPaint(bootAppearanceFor(new Headers()));

describe("first paint, one per choice", () => {
	it("no record: Default, dark chrome, black-translucent, no colour rule", () => {
		fs.rmSync(settingsFile(), { force: true });
		const html = single();
		assert.match(html, /<html data-theme="default">/);
		assert.match(html, /<meta name="theme-color" content="#141414"\/>/);
		assert.match(html, /<meta name="color-scheme" content="dark"\/>/);
		assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"\/>/);
		assert.match(html, /<style data-lh-appearance="">html:root\{--lh-prose-size:16px;--lh-heading-weight:900;\}<\/style>/);
	});

	it("Ivory: the attribute selects the light palette, light chrome, opaque status bar", () => {
		writeSettings({ version: 2, appearance: { theme: "ivory" } });
		const html = single();
		assert.match(html, /<html data-theme="ivory">/);
		assert.match(html, /<meta name="theme-color" content="#faf9f5"\/>/);
		assert.match(html, /<meta name="color-scheme" content="light"\/>/);
		assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="default"\/>/);
	});

	it("Follow system: one theme-color per device mode, both schemes, no script", () => {
		writeSettings({ version: 2, appearance: { theme: "system" } });
		const html = single();
		assert.match(html, /<html data-theme="system">/);
		assert.match(html, /<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#faf9f5"\/>/);
		assert.match(html, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#141414"\/>/);
		assert.match(html, /<meta name="color-scheme" content="light dark"\/>/);
		assert.ok(!html.includes("<script"), "the first frame needs no script");
	});

	it("overrides and type knobs paint in the first HTML too, each theme its own (Follow system: Default's while dark, Ivory's while light)", () => {
		writeSettings({
			version: 2,
			appearance: { theme: "system", colors: { default: { background: "#202020" }, ivory: { accent: "#aa3300" } }, proseFontSize: 20 },
		});
		const html = single();
		assert.match(html, /html:root\{--lh-prose-size:20px;/);
		assert.match(html, /@media not all and \(prefers-color-scheme: light\)\{html:root\[data-theme="system"\]\{--background:#202020;[^}]*--ring:#8d8d8d;/);
		assert.match(html, /@media \(prefers-color-scheme: light\)\{html:root\[data-theme="system"\]\{--background:#faf9f5;[^}]*--ring:#aa3300;/);
		assert.match(html, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#202020"\/>/);
		assert.match(html, /<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#faf9f5"\/>/);
	});
});

describe("first paint is per tenant (multi-user)", () => {
	const A = "00000000-0000-4000-8000-00000000000a";
	const B = "00000000-0000-4000-8000-00000000000b";
	const as = (id: string) => ({ id, name: id, isAdmin: false });
	const headersFor = (id?: string) => new Headers(id ? { "x-auth-request-user": id } : {});
	after(() => {
		delete process.env.LH_MULTI_USER;
	});

	it("each learner gets their own choice; no identity falls back to Default", () => {
		fs.rmSync(settingsFile(), { force: true }); // the single-user record would read as the legacy layout
		process.env.LH_MULTI_USER = "1";
		runAsTenant(as(A), () => writeSettings({ version: 2, appearance: { theme: "ivory" } }));
		runAsTenant(as(B), () => writeSettings({ version: 2, appearance: { theme: "system" } }));
		assert.match(firstPaint(bootAppearanceFor(headersFor(A))), /<html data-theme="ivory">/);
		assert.match(firstPaint(bootAppearanceFor(headersFor(B))), /<html data-theme="system">/);
		assert.match(firstPaint(bootAppearanceFor(headersFor())), /<html data-theme="default">/);
		assert.match(firstPaint(bootAppearanceFor(headersFor("../escape"))), /<html data-theme="default">/);
	});
});
