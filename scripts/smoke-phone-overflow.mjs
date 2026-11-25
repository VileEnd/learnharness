/** Real-browser proof that a session's transcript does not scroll sideways
 * on a 390px phone, in the default reading font and in JetBrains Mono, in
 * the Default and Ivory themes.
 *
 * Run: npm run build && CHROME_PATH=<chrome or chromium binary> node scripts/smoke-phone-overflow.mjs
 * Local only: CI does not run it (the runner has no Chromium).
 *
 * - Starts `next start` on the existing production build (it never builds)
 *   with a disposable copy of tests/fixtures/golden-data, and opens the
 *   fixture teaching chat: inline and display math, wide tables, and a user
 *   message with a long unbroken file path. Stops only the server it started.
 * - Fails when the page or any scroller around the transcript column is
 *   wider than its box. Wide math and tables may scroll, but only inside
 *   their own box (.katex-display, the table wrapper).
 * - Checks that screen readers still get the math: the KaTeX MathML copy is
 *   in the accessibility tree.
 * - Adds, to the disposable copy only, one learner message with attachments
 *   (a very wide image, a tall one, and a drawing copied from the canvas
 *   fixture chat) and checks the thumbnails load and stay inside the column.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { createCanvas } from "@napi-rs/canvas";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-overflow-"));
const CHROME_PATH = process.env.CHROME_PATH;
const CHAT = "chat_mv27rrra_feff23b6";
// Set the way the Appearance provider sets it (components/settings/appearance.tsx).
const FONTS = [
	["default", null],
	["JetBrains Mono", '"JetBrains Mono", var(--font-jetbrains)'],
];
let server;

async function freePort() {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise((resolve) => listener.close(resolve));
	return port;
}

async function startServer() {
	if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) throw new Error("No production build: run `npm run build` first.");
	const data = path.join(home, "data");
	fs.cpSync(path.join(root, "tests/fixtures/golden-data"), data, { recursive: true });
	addAttachmentMessage(data);
	const port = await freePort();
	const env = { ...process.env, NODE_ENV: "production", LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1" };
	let logs = "";
	server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	server.stdout.on("data", (d) => (logs += d));
	server.stderr.on("data", (d) => (logs += d));
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 90_000;
	for (;;) {
		if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
		try {
			if ((await fetch(`${origin}/api/chats`)).ok) return origin;
		} catch {}
		if (Date.now() > deadline) throw new Error(`Server never answered: ${logs}`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

/** A learner message with attachments, written into the disposable copy the way the app stores one: the images
 *  under data/attachments/<chat>/ (content-addressed), the drawing as a DrawingStore submission of the chat. */
function addAttachmentMessage(data) {
	const image = (w, h) => {
		const canvas = createCanvas(w, h);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#3b82f6";
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
		const bytes = canvas.toBuffer("image/png");
		const id = `img_${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
		const dir = path.join(data, "attachments", CHAT);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${id}.png`), bytes);
		return { kind: "image", id };
	};
	const drawing = "drw_c769b8693d77";
	const from = path.join(data, "drawings", "chat_mvr17zp1_fb98d9b6");
	const to = path.join(data, "drawings", CHAT);
	fs.mkdirSync(to, { recursive: true });
	for (const ext of ["json", "png"]) fs.copyFileSync(path.join(from, `${drawing}.${ext}`), path.join(to, `${drawing}.${ext}`));
	const file = path.join(data, "chats", `${CHAT}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8"));
	record.messages.push({
		id: "msg_smoke_attachments",
		role: "user",
		content: "Here are my sketches.",
		attachments: [image(2400, 300), image(300, 1600), { kind: "drawing", id: drawing }],
		timestamp: Date.now(),
	});
	fs.writeFileSync(file, JSON.stringify(record));
}

async function stopServer() {
	if (!server || server.exitCode !== null) return;
	const exited = once(server, "exit");
	server.kill("SIGTERM");
	const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
	await exited;
	clearTimeout(timer);
}

async function main() {
	if (!CHROME_PATH) throw new Error("Set CHROME_PATH to a Chrome or Chromium binary.");
	const origin = await startServer();
	const browser = await puppeteer.launch({ headless: true, executablePath: CHROME_PATH, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
	const failures = [];
	try {
		const page = await browser.newPage();
		await page.setBypassServiceWorker(true);
		await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
		await page.goto(`${origin}/chat/${CHAT}`, { waitUntil: "load", timeout: 120_000 });
		// Hydrated, then a beat: the app may replace the URL after load, which
		// would destroy the page context mid-check.
		await page.waitForFunction(() => {
			const el = document.querySelector(".lh-transcript-column .katex-display");
			return el && Object.keys(document.querySelector(".lh-transcript-column")).some((k) => k.startsWith("__reactFiber"));
		}, { timeout: 60_000 });
		await new Promise((r) => setTimeout(r, 1500));
		// Lazy attachment thumbnails load once in view: load them before measuring, so their real sizes count.
		await page.evaluate(() => document.querySelector(".lh-transcript-column [data-testid=sent-attachments]")?.scrollIntoView({ block: "center" }));
		await page
			.waitForFunction(() => [...document.querySelectorAll(".lh-transcript-column [data-testid=sent-attachments] img")].every((img) => img.complete && img.naturalWidth > 0), { timeout: 15_000 })
			.catch(() => {});
		for (const theme of ["default", "ivory"]) {
			for (const [name, stack] of FONTS) {
				const wide = await page.evaluate(
					async (s, t) => {
						const html = document.documentElement;
						if (s) html.style.setProperty("--font-prose", `${s}, var(--font-sans3), ui-sans-serif, system-ui, sans-serif`);
						else html.style.removeProperty("--font-prose");
						if (t === "ivory") html.dataset.theme = "ivory";
						else delete html.dataset.theme;
						await document.fonts.ready;
						await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
						const column = document.querySelector(".lh-transcript-column");
						const boxes = [html];
						for (let el = column; el; el = el.parentElement) {
							if (el === column || /(auto|scroll)/.test(getComputedStyle(el).overflowX)) boxes.push(el);
						}
						return boxes.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""} ${el.scrollWidth} > ${el.clientWidth}`);
					},
					stack,
					theme,
				);
				const label = `phone 390px · ${theme} · ${name}`;
				if (wide.length) failures.push(`${label}: ${wide.join("; ")}`);
				console.log(`${wide.length ? "FAIL" : "ok  "} ${label}: transcript does not scroll sideways${wide.length ? `: ${wide.join("; ")}` : ""}`);
			}
		}
		// The learner's attachments: thumbnails that loaded, inside the column.
		const thumbs = await page.$$eval(".lh-transcript-column [data-testid=sent-attachments] img", (imgs) => {
			const column = document.querySelector(".lh-transcript-column").getBoundingClientRect();
			return imgs.map((img) => ({ loaded: img.complete && img.naturalWidth > 0, inside: img.getBoundingClientRect().right <= column.right + 1 }));
		});
		const thumbsOk = thumbs.length >= 3 && thumbs.every((t) => t.loaded && t.inside);
		console.log(`${thumbsOk ? "ok  " : "FAIL"} attachment thumbnails load and stay inside the column: ${JSON.stringify(thumbs)}`);
		if (!thumbsOk) failures.push(`attachment thumbnails: ${JSON.stringify(thumbs)}`);
		// Long display math scrolls inside its own box, not the page.
		const ownBox = await page.$$eval(".lh-transcript-column .katex-display", (els) => els.some((el) => el.scrollWidth > el.clientWidth && /(auto|scroll)/.test(getComputedStyle(el).overflowX)));
		console.log(`${ownBox ? "ok  " : "FAIL"} wide display math scrolls inside .katex-display`);
		if (!ownBox) failures.push("no wide .katex-display scrolls in its own box (fixture changed?)");
		// Screen readers keep the math.
		const ax = await page.accessibility.snapshot({ interestingOnly: false });
		let mathNodes = 0;
		const walk = (n) => {
			if (n.role === "MathMLMath" || n.role === "math") mathNodes++;
			for (const c of n.children ?? []) walk(c);
		};
		walk(ax);
		const katexMath = await page.$$eval(".katex-mathml math", (els) => els.length);
		console.log(`${mathNodes > 0 && mathNodes >= katexMath ? "ok  " : "FAIL"} MathML in the accessibility tree: ${mathNodes} math nodes for ${katexMath} formulas`);
		if (!(mathNodes > 0 && mathNodes >= katexMath)) failures.push(`accessibility tree has ${mathNodes} math nodes for ${katexMath} formulas`);
	} finally {
		await browser.close();
		await stopServer();
		fs.rmSync(home, { recursive: true, force: true });
	}
	console.log(`\n${failures.length ? `FAILED: ${failures.length} checks` : "No sideways scroll on a phone"}.`);
	process.exitCode = failures.length ? 1 : 0;
}

main().catch(async (error) => {
	console.error(error);
	await stopServer();
	process.exitCode = 1;
});
