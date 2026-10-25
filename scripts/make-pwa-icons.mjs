/**
 * make-pwa-icons.mjs — render the PWA/home-screen icons from the flat mark
 * (app/icon.svg, also the browser favicon). One-shot; the PNGs are committed.
 *
 *   node scripts/make-pwa-icons.mjs
 *
 * Writes public/icons/icon-{96,192,512}.png (the mark as-is), a maskable
 * variant (mark at 80% on the app background, inside the launcher safe
 * zone), and app/apple-icon.png (180px, iOS home screen).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "app", "icon.svg");
/** The app background (globals.css --background); the maskable plate. */
const BACKGROUND = "#141414";

const svg = fs.readFileSync(SOURCE, "utf8");
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const render = (source, size) => new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();

/** The mark scaled to 80% and centered on a full-bleed background plate. */
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024">
	<rect width="1024" height="1024" fill="${BACKGROUND}"/>
	<g transform="translate(102.4 102.4) scale(0.8)" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">${inner}</g>
</svg>`;

const outputs = [
	["public/icons/icon-96.png", svg, 96],
	["public/icons/icon-192.png", svg, 192],
	["public/icons/icon-512.png", svg, 512],
	["public/icons/icon-maskable-512.png", maskable, 512],
	["app/apple-icon.png", maskable, 180],
];
for (const [relative, source, size] of outputs) {
	const target = path.join(ROOT, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, render(source, size));
	console.log(`[make-pwa-icons] ${relative} (${size}px)`);
}
