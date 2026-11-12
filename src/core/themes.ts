/**
 * THEMES (themes step 2, port of upstream's src/core/themes.ts): the colour
 * vocabulary the learner picks and its translation into the CSS variables
 * the components already consume. Pure and browser-safe: the root layout
 * (first paint), the appearance provider, the Settings section and the
 * tests share it.
 *
 * A theme is twelve colours plus the variant it renders as (dark/light),
 * as upstream has it. The fork ships two presets only (owner ruling
 * 2026-11-12): Default (today's dark colours, exactly) and Ivory (upstream's
 * light preset). The setting is a CHOICE: one of the two, or "system",
 * which shows Ivory while the device is in light mode and Default otherwise.
 * No import or export (out of scope).
 *
 * Per-colour overrides are stored PER THEME (owner ruling 2026-11-12, a
 * deliberate departure from upstream, whose overrides survive every switch):
 * a dark override under Ivory's dark text would make the light theme
 * unreadable. `appearance.colors.default` and `appearance.colors.ivory` each
 * hold that preset's own overrides; a switch shows the target theme's own,
 * and Follow system applies Default's while the device is dark and Ivory's
 * while it is light.
 *
 * Both palettes also live as literals in app/globals.css (the first frame
 * needs them before any script): tests/themes.test.ts pins those blocks
 * equal to themeVars() of each preset.
 */

import type { AppearanceSettings } from "./settings.ts";

/** The variant on screen. */
export type ThemeMode = "dark" | "light";
/** Kept for the mode-aware renderers (graph canvas, mermaid, canvas inks). */
export type RenderedMode = ThemeMode;

/** The twelve theme colours, in the order the Settings grid shows them. */
export const THEME_COLOR_KEYS = [
	"background",
	"accent",
	"surface",
	"bold",
	"border",
	"italic",
	"text",
	"code",
	"textMuted",
	"error",
	"success",
	"warning",
] as const;

/** One of the twelve theme colours. */
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
/** A full palette: every key, each a CSS colour (presets may use oklch,
 *  overrides are always #hex). */
export type ThemeColors = Record<ThemeColorKey, string>;

/** The preset ids. */
export const THEME_IDS = ["default", "ivory"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** One theme's overrides: hex wins over the theme; null/absent = the theme's colour. */
export type ThemeColorOverrides = Partial<Record<ThemeColorKey, string | null>>;
/** `appearance.colors`: each preset's own overrides, by theme id. */
export type AppearanceColorOverrides = Partial<Record<ThemeId, ThemeColorOverrides>>;

/** What the learner picks: a preset, or "system" (follow the device). */
export const THEME_CHOICES = ["default", "ivory", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The choice a record without `appearance.theme` renders. */
export const DEFAULT_THEME_CHOICE: ThemeChoice = "default";

export function isThemeChoice(value: unknown): value is ThemeChoice {
	return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Per-preset tokens that are not among the twelve overridable colours: the
 *  fork's second error token, the filled success button, the strong line ink
 *  and the learner-state fills of the knowledge graph. */
export interface ThemeTokens {
	/** --destructive (the old red-400 in Default; step 1 kept it apart from --lh-error). */
	destructive: string;
	/** --lh-success-strong (the filled "next problem" button, white text on it). */
	successStrong: string;
	/** --lh-line-strong: plan-map outlines, callout borders, the LH mark. */
	lineStrong: string;
	/** --lh-learner-shaky / -learning / -solid: the graph's learner-state fills. */
	learnerShaky: string;
	learnerLearning: string;
	learnerSolid: string;
}

/** A preset. */
export interface Theme {
	id: ThemeId;
	name: string;
	mode: ThemeMode;
	colors: ThemeColors;
	tokens: ThemeTokens;
}

/** #rgb / #rrggbb (case-insensitive). Mirrors settings.isHexColor without
 *  importing it (settings.ts imports this module). */
export function isHex(value: unknown): value is string {
	return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** Default: the app's dark palette as app/globals.css carried it before
 *  themes, value for value (the status colours are the Tailwind 4 oklch
 *  values step 1 compiled to, inline code inherits). Ivory: upstream's preset (warm ivory page,
 *  terracotta accent, blue/green/clay emphasis); its tokens are the fork's
 *  additions, taken from its own status colours. */
export const DEFAULT_THEME: Theme = {
	id: "default",
	name: "Default",
	mode: "dark",
	colors: {
		background: "#141414",
		surface: "#1c1c1c",
		border: "#434343",
		text: "#e6e6e6",
		textMuted: "#8d8d8d",
		accent: "#8d8d8d",
		bold: "#e6e6e6",
		italic: "#e6e6e6",
		// Inline code inherited the surrounding text before themes (muted in
		// a quote, the text colour elsewhere); currentColor keeps exactly that.
		code: "currentColor",
		error: "oklch(0.637 0.237 25.331)",
		success: "oklch(0.723 0.219 149.579)",
		warning: "oklch(0.769 0.188 70.08)",
	},
	tokens: {
		destructive: "oklch(0.704 0.191 22.216)",
		successStrong: "oklch(0.627 0.194 149.214)",
		lineStrong: "#ffffff",
		learnerShaky: "#ef4444",
		learnerLearning: "#eab308",
		learnerSolid: "#22c55e",
	},
};

export const IVORY_THEME: Theme = {
	id: "ivory",
	name: "Ivory",
	mode: "light",
	colors: {
		background: "#faf9f5",
		surface: "#f0eee6",
		border: "#e0ddd2",
		text: "#3d3d3a",
		textMuted: "#83827d",
		accent: "#d97757",
		bold: "#3266c9",
		italic: "#3f8f6b",
		code: "#c4613f",
		error: "#c43d3d",
		success: "#3f8f6b",
		warning: "#b8822a",
	},
	tokens: {
		destructive: "#c43d3d",
		successStrong: "#33775a",
		lineStrong: "#3d3d3a",
		learnerShaky: "#c43d3d",
		learnerLearning: "#b8822a",
		learnerSolid: "#3f8f6b",
	},
};

/** The presets, in card order. */
export const BUILTIN_THEMES: readonly Theme[] = [DEFAULT_THEME, IVORY_THEME];

/** The preset an id names (Default for anything else). */
export function resolveTheme(id: string | null | undefined): Theme {
	return BUILTIN_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}

/** The stored choice, or the default one. */
export function themeChoiceOf(appearance: AppearanceSettings | undefined): ThemeChoice {
	return isThemeChoice(appearance?.theme) ? appearance.theme : DEFAULT_THEME_CHOICE;
}

/** The preset shown for a mode: the light one is Ivory, the dark one Default. */
export function themeForMode(mode: ThemeMode): Theme {
	return mode === "light" ? IVORY_THEME : DEFAULT_THEME;
}

/** The mode a choice renders in, given the device's preference (only
 *  "system" reads it). */
export function renderedModeOf(choice: ThemeChoice, deviceMode: ThemeMode): ThemeMode {
	return choice === "system" ? deviceMode : resolveTheme(choice).mode;
}

/** This theme's own overrides from the record (never another theme's). */
export function themeOverrides(theme: Theme, appearance: AppearanceSettings | undefined): ThemeColorOverrides {
	return appearance?.colors?.[theme.id] ?? {};
}

/** The single place a theme's overrides merge onto it. A null/absent/
 *  invalid override = the theme's colour. */
export function effectiveColors(theme: Theme, appearance: AppearanceSettings | undefined): ThemeColors {
	const out: ThemeColors = { ...theme.colors };
	const own = themeOverrides(theme, appearance);
	for (const key of THEME_COLOR_KEYS) {
		const v = own[key];
		if (isHex(v)) out[key] = v;
	}
	return out;
}

/** Shift every channel by `add`, clamped to 0–255 (always #rrggbb out). */
export function shiftHex(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.min(255, Math.max(0, c + add)).toString(16).padStart(2, "0")).join("")}`;
}

/** The hover surface sits one step off `surface`: lighter on dark, darker
 *  on light (#1c1c1c → #2a2a2a, the original hand-picked hover). */
const HOVER_STEP = 14;

/** THE adapter: a preset plus the record's overrides → the CSS variables of
 *  that palette. `--accent` stays the shadcn HOVER surface (derived from
 *  `surface`, so hovers never turn the highlight colour); the theme's accent
 *  is `--ring` and `--lh-accent`. `--destructive` and `--lh-success-strong`
 *  are the preset's own unless the learner overrides error or success, then
 *  they follow the override. */
export function themeVars(theme: Theme, appearance?: AppearanceSettings): Record<string, string> {
	const c = effectiveColors(theme, appearance);
	const t = theme.tokens;
	const own = themeOverrides(theme, appearance);
	const overridden = (key: ThemeColorKey) => isHex(own[key]);
	return {
		"--background": c.background,
		"--foreground": c.text,
		"--card": c.surface,
		"--card-foreground": c.text,
		"--popover": c.surface,
		"--popover-foreground": c.text,
		"--primary": c.text,
		"--primary-foreground": c.background,
		"--secondary": c.surface,
		"--secondary-foreground": c.text,
		"--muted": c.surface,
		"--muted-foreground": c.textMuted,
		"--accent": isHex(c.surface) ? shiftHex(c.surface, theme.mode === "dark" ? HOVER_STEP : -HOVER_STEP) : c.surface,
		"--accent-foreground": c.text,
		"--destructive": overridden("error") ? c.error : t.destructive,
		"--border": c.border,
		"--input": c.border,
		"--ring": c.accent,
		"--lh-accent": c.accent,
		"--lh-line-strong": t.lineStrong,
		"--lh-ink-strong": c.bold,
		"--lh-ink-italic": c.italic,
		"--lh-ink-code": c.code,
		"--lh-error": c.error,
		"--lh-success": c.success,
		"--lh-success-strong": overridden("success") ? c.success : t.successStrong,
		"--lh-warning": c.warning,
		"--lh-learner-shaky": t.learnerShaky,
		"--lh-learner-learning": t.learnerLearning,
		"--lh-learner-solid": t.learnerSolid,
	};
}

/** The colours the browser chrome (theme-color) should take while the
 *  device is in light mode and in dark mode: the background of the preset
 *  each case shows, overrides applied. Equal for a fixed preset. */
export function chromeColors(appearance: AppearanceSettings | undefined): Record<ThemeMode, string> {
	const choice = themeChoiceOf(appearance);
	const bg = (mode: ThemeMode) => effectiveColors(themeForMode(renderedModeOf(choice, mode)), appearance).background;
	return { light: bg("light"), dark: bg("dark") };
}

/** The theme-color the page declares (Next's Viewport.themeColor shape):
 *  one colour for a fixed preset, a light and a dark one with media queries
 *  for Follow system. */
export function themeColorMeta(
	appearance: AppearanceSettings | undefined,
): string | { media: string; color: string }[] {
	const chrome = chromeColors(appearance);
	return chrome.light === chrome.dark
		? chrome.dark
		: [
				{ media: "(prefers-color-scheme: light)", color: chrome.light },
				{ media: "(prefers-color-scheme: dark)", color: chrome.dark },
			];
}

/** The `color-scheme` the page declares before any stylesheet loads. */
export function colorSchemeOf(choice: ThemeChoice): "dark" | "light" | "light dark" {
	return choice === "system" ? "light dark" : resolveTheme(choice).mode;
}

/** The iOS status bar style for an installed web app (read once, when the
 *  app is added to the home screen). Default keeps today's
 *  black-translucent (white text, the page drawn under the bar; pt-safe pads
 *  it). A light page cannot carry white text, so Ivory and "system" ask for
 *  "default": an opaque bar with dark text, the page starting below it. */
export function statusBarStyleOf(choice: ThemeChoice): "black-translucent" | "default" {
	return choice === "default" ? "black-translucent" : "default";
}
