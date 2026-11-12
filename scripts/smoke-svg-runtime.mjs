/**
 * OFFLINE SVG runtime gate: the payload's own @resvg/resvg-js is the only way
 * the visual maker rasterizes a figure, so prove here that the native binary
 * loads from the standalone tree and draws. A filled rectangle at a fixed
 * width proves the binary and the PNG size; with `--text`, one glyph proves
 * the system fonts too (the build stage of the Dockerfile has none, the
 * runtime stage installs them, so only the latter passes --text).
 *
 * node scripts/smoke-svg-runtime.mjs [--standalone <dir>] [--runtime <Node>] [--text]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatProbeError, probeEnv } from "./smoke-demo-runtime.mjs";

// Runs inside the payload directory with a minimal environment, so `require`
// can only find what the standalone tree itself ships.
const PROBE = `
const path = require("node:path");
const { createRequire } = require("node:module");
const resolved = createRequire(path.join(process.cwd(), "server.js")).resolve("@resvg/resvg-js");
const { Resvg } = require(resolved);
const render = (svg, width) => {
	const image = new Resvg(svg, { fitTo: { mode: "width", value: width }, background: "#ffffff", font: { loadSystemFonts: true } }).render();
	return { png: image.asPng(), width: image.width, height: image.height, pixels: image.pixels };
};
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const rect = render('<svg ' + NS + ' width="10" height="5"><rect width="10" height="5" fill="#ff0000"/></svg>', 40);
const mid = (rect.height / 2 | 0) * rect.width * 4 + (rect.width / 2 | 0) * 4;
const out = { resolved, signature: rect.png.subarray(0, 8).toString("hex"), width: rect.width, height: rect.height, center: [...rect.pixels.subarray(mid, mid + 4)] };
if (process.argv[1] === "text") {
	const text = render('<svg ' + NS + ' width="64" height="32"><text x="4" y="24" font-family="sans-serif" font-size="24" fill="#000000">Hg</text></svg>', 64);
	let dark = 0;
	for (let i = 0; i < text.pixels.length; i += 4) if (text.pixels[i] < 128) dark++;
	out.darkTextPixels = dark;
}
console.log(JSON.stringify(out));
`;

export function verifySvgRuntime(standalone, runtime = process.execPath, text = false) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-svg-runtime-"));
	try {
		const run = spawnSync(runtime, ["-e", PROBE, ...(text ? ["text"] : [])], {
			cwd: standalone, env: probeEnv(process.env, home), encoding: "utf-8", timeout: 60_000,
		});
		assert.equal(run.status, 0, `the payload's resvg did not render:\n${run.stderr}${run.stdout}`);
		const result = JSON.parse(run.stdout.trim().split("\n").pop());
		assert.ok(result.resolved.startsWith(fs.realpathSync(standalone) + path.sep), `resvg resolved outside the payload: ${result.resolved}`);
		assert.equal(result.signature, "89504e470d0a1a0a", "PNG signature");
		assert.deepEqual([result.width, result.height], [40, 20], "PNG size at the fixed width");
		assert.deepEqual(result.center, [255, 0, 0, 255], "the filled rectangle is drawn");
		if (text) assert.ok(result.darkTextPixels > 20, `no glyph pixels drawn (${result.darkTextPixels}): the system fonts are missing`);
		console.log(`[smoke-svg-runtime] payload resvg rendered a 40x20 PNG with a filled rectangle${text ? ` and a glyph (${result.darkTextPixels} text pixels)` : ""}; confined to ${standalone}`);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function main() {
	const args = process.argv.slice(2);
	const value = (name, fallback) => {
		const index = args.indexOf(name);
		if (index < 0) return fallback;
		assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a path`);
		return path.resolve(args[index + 1]);
	};
	verifySvgRuntime(value("--standalone", path.resolve(import.meta.dirname, "../.next/standalone")), value("--runtime", process.execPath), args.includes("--text"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(); } catch (err) { console.error(`[smoke-svg-runtime] FAIL: ${formatProbeError(err)}`); process.exitCode = 1; }
}
