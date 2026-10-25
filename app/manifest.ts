import type { MetadataRoute } from "next";

/**
 * The web app manifest (browser-only self-hosting, 2026-10-25): makes the
 * app installable as a PWA (own window, home-screen icon). No service
 * worker — the app needs its server anyway, so there is nothing to serve
 * offline. Colors are the dark theme's --background (app/globals.css).
 * Icons come from scripts/make-pwa-icons.mjs.
 */
export default function manifest(): MetadataRoute.Manifest {
	return {
		// A stable identity: the installed app survives start_url changes.
		id: "/",
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "An agent harness for learning: adaptive teaching, practice, and a persistent knowledge graph.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		display_override: ["standalone"],
		// Launching again (icon, shortcut, notification) focuses the open app.
		launch_handler: { client_mode: "focus-existing" },
		categories: ["education", "productivity"],
		background_color: "#141414",
		theme_color: "#141414",
		shortcuts: [
			{ name: "New session", short_name: "New", url: "/chat/new", icons: [{ src: "/icons/icon-96.png", sizes: "96x96", type: "image/png" }] },
			{ name: "Settings", url: "/settings", icons: [{ src: "/icons/icon-96.png", sizes: "96x96", type: "image/png" }] },
		],
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
			{ src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
