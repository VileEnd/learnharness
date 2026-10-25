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
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "An agent harness for learning: adaptive teaching, practice, and a persistent knowledge graph.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
			{ src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
