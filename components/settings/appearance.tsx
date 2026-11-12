"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19; themes step 2,
 * 2026-11-12): the settings record's appearance section, applied.
 *
 *   - The theme CHOICE is the `data-theme` attribute on <html> (default,
 *     ivory or system); app/globals.css holds both palettes and switches on
 *     it (Follow system through prefers-color-scheme). The root layout
 *     renders the attribute from the record, so the first frame is right;
 *     this provider moves it on a live change.
 *   - Everything else the record changes (reading font, sizes, heading
 *     weight, colour overrides) is one CSS text (core/appearance-css.ts)
 *     rendered here as a <style>: server-rendered into the first HTML, and
 *     re-rendered on every change. No inline style on <html> to clean up.
 *   - The rendered mode (light/dark) for the JavaScript renderers (graph
 *     canvas, mermaid, canvas inks, chart colours) is derived here: the
 *     choice, or the device's preference for Follow system, which switches
 *     live through matchMedia.
 *   - The browser chrome (theme-color metas) follows.
 *
 * The provider is mounted at the ROOT LAYOUT level: the layout passes the
 * record's appearance it read in the request's tenant scope. The settings
 * page writes a section and hands the new appearance here.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import {
	appearanceCss,
	chromeColors,
	colorSchemeOf,
	DEFAULT_THEME,
	effectiveColors,
	renderedModeOf,
	resolveAppearance,
	themeChoiceOf,
	themeForMode,
	type AppearanceSettings,
	type RenderedMode,
	type Theme,
	type ThemeChoice,
	type ThemeColors,
} from "@/src/core";

export { BUNDLED_READING_FONTS, resolveAppearance } from "@/src/core";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function subscribeDevice(onChange: () => void): () => void {
	const mq = window.matchMedia(LIGHT_QUERY);
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}
const deviceMode = (): RenderedMode => (window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark");
// The server cannot know the device: it renders the dark fallback, and the
// first client render after hydration corrects it (CSS already did).
const serverDeviceMode = (): RenderedMode => "dark";

/** Which colour a theme-color meta takes: by its media query, else the
 *  colour of the mode on screen. Pure — exported for tests. */
export function themeColorFor(media: string, chrome: Record<RenderedMode, string>, mode: RenderedMode): string {
	if (media.includes("light")) return chrome.light;
	if (media.includes("dark")) return chrome.dark;
	return chrome[mode];
}

interface AppearanceContextValue {
	/** Resolved appearance (the record's delta over the factory). */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The theme choice (default, ivory, system). */
	choice: ThemeChoice;
	/** The mode on screen (Follow system resolved against the device). */
	resolvedMode: RenderedMode;
	/** The preset on screen. */
	activeTheme: Theme;
	/** The preset on screen with every override applied. */
	colors: ThemeColors;
	/** Changes whenever any colour on screen changes: a dependency for the
	 *  renderers that read the CSS tokens into a canvas. */
	paletteKey: string;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	choice: "default",
	resolvedMode: "dark",
	activeTheme: DEFAULT_THEME,
	colors: DEFAULT_THEME.colors,
	paletteKey: "dark",
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	children,
	initialAppearance,
}: {
	children: React.ReactNode;
	/** The record's appearance section, read by the root layout. */
	initialAppearance: AppearanceSettings | undefined;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(initialAppearance);
	const device = useSyncExternalStore(subscribeDevice, deviceMode, serverDeviceMode);
	const choice = themeChoiceOf(delta);
	const resolvedMode = renderedModeOf(choice, device);
	const css = useMemo(() => appearanceCss(delta), [delta]);
	const chrome = useMemo(() => chromeColors(delta), [delta]);

	// The choice lives on <html> (the layout rendered the first one). A
	// LAYOUT effect: descendants' passive effects run after it, so anything
	// reading computed tokens (the graph canvas) sees the new palette.
	useLayoutEffect(() => {
		document.documentElement.dataset.theme = choice;
	}, [choice]);

	// The browser / installed-app chrome follows the page background.
	useEffect(() => {
		for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
			meta.content = themeColorFor(meta.media, chrome, resolvedMode);
		}
		const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
		if (scheme) scheme.content = colorSchemeOf(choice);
	}, [chrome, resolvedMode, choice]);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const value = useMemo(() => {
		const activeTheme = themeForMode(resolvedMode);
		return {
			appearance: resolveAppearance(delta),
			choice,
			resolvedMode,
			activeTheme,
			colors: effectiveColors(activeTheme, delta),
			paletteKey: `${resolvedMode}\n${css}`,
			onAppearanceChange,
		};
	}, [delta, choice, resolvedMode, css, onAppearanceChange]);
	return (
		<AppearanceContext.Provider value={value}>
			{/* Validated hex and an escaped font name only (appearance-css.ts). */}
			<style data-lh-appearance="" dangerouslySetInnerHTML={{ __html: css }} />
			{children}
		</AppearanceContext.Provider>
	);
}
