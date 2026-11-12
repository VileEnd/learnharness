/**
 * THE APPEARANCE STYLESHEET (themes step 2): the record's appearance section
 * as one small CSS text, rendered by the appearance provider into a <style>
 * element. The server renders it into the first HTML (so the first frame
 * already has the learner's fonts, sizes and colour overrides) and the
 * provider re-renders it on every live change. Pure and browser-safe.
 *
 * The theme CHOICE is not in here: it is the `data-theme` attribute on
 * <html>, and app/globals.css holds both palettes (Default on :root, Ivory
 * on [data-theme="ivory"] and, under prefers-color-scheme: light, on
 * [data-theme="system"]). This text only adds what the record changes:
 *   - the type knobs, on every palette;
 *   - colour overrides, which are stored per theme: when Default has its
 *     own, its full palette for [data-theme="default"] (and no attribute)
 *     and for [data-theme="system"] while the device is NOT light; when
 *     Ivory has its own, its full palette for [data-theme="ivory"] and for
 *     [data-theme="system"] while the device IS light. The selectors never
 *     overlap, so one theme's overrides cannot reach the other's page; each
 *     is one step more specific than its globals.css block, so it wins
 *     without !important.
 * Every colour that reaches the text passed isHex(); the one free-text
 * value (the font family) is escaped as a CSS string, so no record value
 * can end the rule or the element.
 */

import { FACTORY_SETTINGS, type AppearanceSettings } from "./settings.ts";
import { DEFAULT_THEME, IVORY_THEME, themeVars, type Theme } from "./themes.ts";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		theme: delta?.theme ?? f.theme,
		colors: delta?.colors ?? f.colors,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
		},
	};
}

/** Reading fonts the app ships itself (next/font in app/layout.tsx), by
 *  family name → the CSS variable carrying the bundled face. They work
 *  without being installed: an installed copy wins by name, the bundled
 *  one fills in otherwise. */
export const BUNDLED_READING_FONTS: Readonly<Record<string, string>> = {
	"JetBrains Mono": "var(--font-jetbrains)",
};

/** A CSS string literal: quotes and backslashes escaped, line breaks
 *  dropped, `<` as an escape so the text can never close a <style>. */
export function cssString(value: string): string {
	return `"${value.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, " ").replace(/</g, "\\3c ")}"`;
}

/** The type knobs → CSS variables. Absent entries leave the stylesheet
 *  value in place. */
export function appearanceTypeVars(a: ReturnType<typeof resolveAppearance>): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.fontFamily !== null) {
		const bundled = Object.hasOwn(BUNDLED_READING_FONTS, a.fontFamily) ? BUNDLED_READING_FONTS[a.fontFamily] : undefined;
		vars["--font-prose"] = `${cssString(a.fontFamily)}, ${bundled ? `${bundled}, ` : ""}var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family (the .font-title utility reads it).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	return vars;
}

/** The palette a preset shows with this record's overrides, or null when
 *  no override changes anything in it (the globals.css block stands). */
export function overriddenPalette(theme: Theme, appearance: AppearanceSettings | undefined): Record<string, string> | null {
	const stock = themeVars(theme);
	const vars = themeVars(theme, appearance);
	return Object.keys(vars).some((k) => vars[k] !== stock[k]) ? vars : null;
}

const rule = (selector: string, vars: Record<string, string>) =>
	`${selector}{${Object.entries(vars)
		.map(([k, v]) => `${k}:${v};`)
		.join("")}}`;

const DARK_SELECTOR = 'html:root:not([data-theme="ivory"]):not([data-theme="system"])';
const SYSTEM_SELECTOR = 'html:root[data-theme="system"]';

/** THE text: see the module header. */
export function appearanceCss(appearance: AppearanceSettings | undefined): string {
	const out = [rule("html:root", appearanceTypeVars(resolveAppearance(appearance)))];
	const dark = overriddenPalette(DEFAULT_THEME, appearance);
	if (dark) {
		out.push(rule(DARK_SELECTOR, dark));
		out.push(`@media not all and (prefers-color-scheme: light){${rule(SYSTEM_SELECTOR, dark)}}`);
	}
	const light = overriddenPalette(IVORY_THEME, appearance);
	if (light) {
		out.push(rule('html:root[data-theme="ivory"]', light));
		out.push(`@media (prefers-color-scheme: light){${rule(SYSTEM_SELECTOR, light)}}`);
	}
	return out.join("\n");
}
