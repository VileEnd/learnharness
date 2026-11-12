import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Shantell_Sans, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { PwaRuntime } from "@/components/pwa-runtime";
import { SessionWatch } from "@/components/session-watch";
import { colorSchemeOf, statusBarStyleOf, themeChoiceOf, themeColorMeta } from "@/src/core";
import { readBootAppearance } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });
// The teacher's red-pen hand on the canvas marks (components/canvas/teacher-ink.tsx, B2 2026-10-28).
const teacherHand = Shantell_Sans({ subsets: ["latin"], weight: ["500"], variable: "--font-teacher-hand" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	// Installed to an iOS home screen (the manifest covers everyone else):
	// the layout renders those metas itself, because the status bar style
	// depends on the theme (Next's appleWebApp always adds its own style
	// meta, and generateMetadata would stream it into <body>).
};

/** The browser chrome follows the learner's theme from the first frame:
 *  one theme-color for a fixed preset, a light and a dark one (media
 *  attributes) for "Follow system". The provider updates them live. Blocking
 *  (viewport is never streamed), one record read per request (React cache). */
export async function generateViewport(): Promise<Viewport> {
	const appearance = await readBootAppearance();
	return {
		themeColor: themeColorMeta(appearance),
		colorScheme: colorSchemeOf(themeChoiceOf(appearance)),
		// Edge to edge on notched phones; layouts pad with the *-safe utilities.
		viewportFit: "cover",
		// Android: the on-screen keyboard shrinks the layout viewport (dvh), so
		// bottom-docked composers stay above it. iOS ignores this (visualViewport).
		interactiveWidget: "resizes-content",
	};
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// THE FIRST FRAME (themes step 2): the theme choice is an attribute on
	// <html>, and app/globals.css holds both palettes (Follow system is a
	// prefers-color-scheme media query there), so the right colours paint
	// before any script runs. The record is read in this request's tenant
	// scope (src/server/theme-boot.ts); the appearance provider renders the
	// record's fonts and colour overrides as a <style> in the same HTML.
	const appearance = await readBootAppearance();
	const choice = themeChoiceOf(appearance);
	return (
		<html
			lang="en"
			data-theme={choice}
			className={`${ui.variable} ${prose.variable} ${teacherHand.variable}`}
			suppressHydrationWarning
		>
			<head>
				<meta name="mobile-web-app-capable" content="yes" />
				<meta name="apple-mobile-web-app-title" content="LearnHarness" />
				{/* iOS reads the style when the app is added to the home screen:
				    black-translucent (white text, page under the bar) for Default,
				    an opaque bar with dark text otherwise (core/themes.ts). */}
				<meta name="apple-mobile-web-app-status-bar-style" content={statusBarStyleOf(choice)} />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider initialAppearance={appearance}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Installed-app runtime: the service worker + update toast, and the
				 signed-out screen when the login session ends. */}
			<PwaRuntime />
			<SessionWatch />
		</body>
		</html>
	);
}
