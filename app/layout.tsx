import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { PwaRuntime } from "@/components/pwa-runtime";
import { SessionWatch } from "@/components/session-watch";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	// Installed to an iOS home screen (the manifest covers everyone else).
	// black-translucent: the app draws under the status bar (pt-safe pads it).
	appleWebApp: { capable: true, title: "LearnHarness", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
	// The live value follows the appearance background (AppearanceProvider).
	themeColor: "#141414",
	colorScheme: "dark",
	// Edge to edge on notched phones; layouts pad with the *-safe utilities.
	viewportFit: "cover",
	// Android: the on-screen keyboard shrinks the layout viewport (dvh), so
	// bottom-docked composers stay above it. iOS ignores this (visualViewport).
	interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
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
