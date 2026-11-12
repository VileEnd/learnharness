import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { svgImageSource } from "../../core/svg-image-source.ts";
import { guardedFetch, OutboundRefusedError, readCapped, withTimeout } from "../outbound.ts";
import { standardFontsDir } from "./pdf-ops";

/**
 * Verification engines for sub-agents: demos run in a system Chrome/
 * Chromium via puppeteer-core (the Docker image installs Chromium and sets
 * CHROME_PATH). SVGs use only resvg (no browser, no fallback); PDFs use pdfjs
 * + Skia (no browser). No Chromium is downloaded at runtime.
 *
 * Chrome resolution: CHROME_PATH first, then common macOS, Windows and
 * Linux install paths. `available()` is a cheap executable check; the
 * launch must still succeed at job time.
 *
 * Test seam: `headlessOverride.current` replaces the whole API (tests inject
 * a fake; nothing here touches a real browser). Builders call `getHeadless()`.
 *
 * LOCKDOWN (2026-11-12 audit): the model writes the page and the demo
 * probe, and the probe's value goes back to the model, so the browser must
 * not read local files or reach the app's network. Every request is
 * intercepted (demoRequestDecision): the document itself, data: and blob:
 * pass; http(s) is fetched by this process through the outbound guard and
 * handed to the page; everything else (other files, other schemes, any
 * main-frame navigation away from the document) is aborted. Chromium
 * itself gets no route anywhere (dead proxy, no host resolution, no
 * unproxied UDP), which covers what interception cannot see: WebSockets,
 * popups, WebRTC. It launches with a minimal environment, and the probe
 * only runs while the page is still the demo document.
 */

export interface DemoRunResult {
	/** console.error / console messages of type "error". */
	consoleErrors: string[];
	/** Uncaught exceptions (window.onerror / unhandled rejections). */
	pageErrors: string[];
	/** Network requests that failed (CDN scripts that didn't load, …). */
	failedRequests: string[];
	/** Value of the optional probe expression, when requested and successful. */
	probeResult?: unknown;
	/** True when nothing above recorded anything. */
	ok: boolean;
}

export interface RunDemoOptions {
	/** How long to let the page settle (animations, async CDN loads) — default 2s. */
	settleMs?: number;
	/** Optional JS expression evaluated in the page after settling; its value
	 * is returned to the builder so it can assert on internal state. */
	probe?: string;
}

export interface RenderSvgOptions {
	/** Viewport size — defaults to the SVG's width/height attrs, else 900×700. */
	width?: number;
	height?: number;
}

export interface RenderPdfOptions {
	/** Render DPI — 72 is 100% zoom; the skill's guidance is 100/150/200. */
	dpi?: number;
}

export interface RenderedPdfPage {
	page: number;
	png: Buffer;
}

export interface HeadlessApi {
	/** True when a Chrome/Chromium is resolvable (cheap, no launch). */
	available(): boolean;
	/** Why not — for error messages. */
	unavailableReason(): string | null;
	/** Execute HTML in a browser, capture errors, optionally probe. */
	runDemo(html: string, opts?: RunDemoOptions): Promise<DemoRunResult>;
	/** Rasterize an SVG to a PNG buffer (for verify-by-looking). */
	renderSvg(svg: string, opts?: RenderSvgOptions): Promise<Buffer>;
	/** Render PDF pages to PNGs natively (pdfjs + Skia) for the pdf-reader. */
	renderPdfPages(pdfPath: string, pages: number[], opts?: RenderPdfOptions): Promise<RenderedPdfPage[]>;
}

/** Test seam — undefined in production. */
export const headlessOverride: { current?: HeadlessApi } = {};

export function getHeadless(): HeadlessApi {
	return headlessOverride.current ?? realHeadless;
}

// ─── Chrome resolution ───────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
	...(process.platform === "win32" ? [
		path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
		...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
	] : []),
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export function resolveChromeExecutablePath(): string | null {
	const candidates = [process.env.CHROME_PATH, ...CHROME_CANDIDATES].filter(
		(p): p is string => typeof p === "string" && p.length > 0,
	);
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			/* not readable — try the next */
		}
	}
	return null;
}

const NO_CHROME_MESSAGE =
	"No render engine available: no system Chrome/Chromium was found. " +
	"Install Chromium or set CHROME_PATH to a Chrome executable. " +
	"(Verification is mandatory — demos are never delivered untested.)";

/** What the page may load. `documentUrl` is the one local file it may
 *  read (the demo or figure page itself). */
export type DemoRequestDecision = "continue" | "fetch" | "abort";

function withoutHash(url: string): string {
	const i = url.indexOf("#");
	return i < 0 ? url : url.slice(0, i);
}

export function demoRequestDecision(url: string, documentUrl: string, mainFrameNavigation: boolean): DemoRequestDecision {
	if (withoutHash(url) === withoutHash(documentUrl)) return "continue";
	if (mainFrameNavigation) return "abort";
	const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
	if (scheme === "data:" || scheme === "blob:") return "continue";
	if (scheme === "http:" || scheme === "https:") return "fetch";
	return "abort";
}

/** Per-resource cap for what the page loads from the web (CDN libraries,
 *  fonts, wasm). */
const MAX_PAGE_RESOURCE_BYTES = 32 * 1024 * 1024;
const PAGE_RESOURCE_TIMEOUT_MS = 30_000;
/** Request headers worth passing on to the real server. */
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "user-agent", "origin", "range"];
/** Response headers that describe the wire, not the (decoded) body. */
const DROPPED_RESPONSE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"]);

/** These fetches run, and their bodies sit, in the shared server process
 *  (Chromium used to stream them in its own processes), so one run is
 *  bounded: a few fetches at once, a short queue behind them, and a byte
 *  budget across all of its resources. Past any of these the request is
 *  refused (blockedbyclient). */
const MAX_CONCURRENT_PAGE_FETCHES = 6;
const MAX_QUEUED_PAGE_FETCHES = 64;
const MAX_PAGE_BYTES_PER_RUN = 128 * 1024 * 1024;

class PageBudgetError extends Error {
	constructor() {
		super("the page's download budget for this run is spent");
		this.name = "PageBudgetError";
	}
}

export interface PageFetchLimits {
	/** Wait for a fetch slot; false when the queue is full, the budget is
	 *  spent or the page is closing. A true result must be released. */
	acquire(signal: AbortSignal): Promise<boolean>;
	release(): void;
	/** Count bytes against the run's budget; throws once it is spent. */
	charge(bytes: number): void;
}

export function createPageFetchLimits(
	opts: { maxConcurrent?: number; maxQueued?: number; maxBytes?: number } = {},
): PageFetchLimits {
	const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_PAGE_FETCHES;
	const maxQueued = opts.maxQueued ?? MAX_QUEUED_PAGE_FETCHES;
	const maxBytes = opts.maxBytes ?? MAX_PAGE_BYTES_PER_RUN;
	let active = 0;
	let spent = 0;
	const waiting: Array<(granted: boolean) => void> = [];
	const exhausted = () => spent > maxBytes;
	return {
		acquire(signal) {
			if (exhausted() || signal.aborted) return Promise.resolve(false);
			if (active < maxConcurrent) {
				active++;
				return Promise.resolve(true);
			}
			if (waiting.length >= maxQueued) return Promise.resolve(false);
			return new Promise<boolean>((resolve) => {
				const waiter = (granted: boolean) => {
					signal.removeEventListener("abort", onAbort);
					resolve(granted);
				};
				const onAbort = () => {
					const i = waiting.indexOf(waiter);
					if (i >= 0) waiting.splice(i, 1);
					resolve(false);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				waiting.push(waiter);
			});
		},
		release() {
			active--;
			while (waiting.length > 0 && active < maxConcurrent) {
				const next = waiting.shift()!;
				if (exhausted()) next(false);
				else {
					active++;
					next(true);
				}
			}
		},
		charge(bytes) {
			spent += bytes;
			if (exhausted()) throw new PageBudgetError();
		},
	};
}

/** The parts of an intercepted request this module uses. */
type InterceptedRequest = Pick<import("puppeteer-core").HTTPRequest, "url" | "method" | "headers" | "respond" | "abort">;

/** Fetch one http(s) request through the outbound guard and hand the result
 *  to the page; a refused or failed fetch aborts the request. */
export async function fulfilThroughGuard(
	req: InterceptedRequest,
	signal: AbortSignal,
	limits: PageFetchLimits,
): Promise<void> {
	const method = req.method();
	if (method !== "GET" && method !== "HEAD") {
		await req.abort("blockedbyclient").catch(() => {});
		return;
	}
	if (!(await limits.acquire(signal))) {
		await req.abort("blockedbyclient").catch(() => {});
		return;
	}
	try {
		const incoming = req.headers();
		const headers: Record<string, string> = {};
		for (const name of FORWARDED_REQUEST_HEADERS) {
			const value = incoming[name];
			if (value !== undefined) headers[name] = value;
		}
		const { response } = await guardedFetch(req.url(), {
			method,
			headers,
			signal: withTimeout(signal, PAGE_RESOURCE_TIMEOUT_MS),
		});
		const body =
			method === "HEAD"
				? new Uint8Array(0)
				: await readCapped(response, MAX_PAGE_RESOURCE_BYTES, undefined, (bytes) => limits.charge(bytes));
		const outHeaders: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			if (!DROPPED_RESPONSE_HEADERS.has(name)) outHeaders[name] = value;
		});
		// A view on the same bytes, not a copy.
		await req.respond({
			status: response.status,
			headers: outHeaders,
			body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
		});
	} catch (err) {
		const refused = err instanceof OutboundRefusedError || err instanceof PageBudgetError;
		await req.abort(refused ? "blockedbyclient" : "failed").catch(() => {});
	} finally {
		limits.release();
	}
}

/** Only what Chromium needs from the environment: never the server's own
 *  (provider keys, admin secrets). HOME and the XDG dirs point at the
 *  throwaway profile. */
export const CHROME_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "SYSTEMROOT", "WINDIR"];

function chromeEnv(profile: string): Record<string, string> {
	const env: Record<string, string> = { HOME: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile };
	for (const key of CHROME_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** Chromium's launch flags. scripts/smoke-demo-runtime.mjs launches the
 *  image's Chromium with a copy of these and of CHROME_ENV_KEYS (it cannot
 *  import this module); tests/demo-runtime-payload.test.ts keeps the two
 *  equal. */
export const CHROME_ARGS = [
	"--disable-gpu",
	// Chromium's own sandbox needs user namespaces the container does not
	// provide, so it stays off; the lockdown in this module is what confines
	// the page.
	"--no-sandbox",
	"--disable-dev-shm-usage",
	// No route for Chromium itself: every http(s) request the page makes is
	// intercepted and fetched by this process through the outbound guard, so
	// Chromium never needs the network. This catches what interception
	// cannot see (WebSockets, popups).
	"--proxy-server=http://0.0.0.0:0",
	"--proxy-bypass-list=<-loopback>",
	"--host-resolver-rules=MAP * ~NOTFOUND",
	// WebRTC may not send UDP around the (dead) proxy.
	"--webrtc-ip-handling-policy=disable_non_proxied_udp",
];

async function withBrowserPage<T>(
	documentUrl: string,
	fn: (page: import("puppeteer-core").Page) => Promise<T>,
): Promise<T> {
	// Per-job launch, close on the way out.
	const puppeteer = (await import("puppeteer-core")).default;
	const executablePath = resolveChromeExecutablePath();
	// Own writable profile per launch: in the container the server runs as the
	// node user with HOME=/root, where Chromium cannot create its profile or
	// crashpad database and dies at launch (seen on the VM, 2026-10-25).
	const profile = tempDir("lh-chrome-");
	// Ends every fetch still running (or queued) for the page once it closes.
	const pageLife = new AbortController();
	const fetchLimits = createPageFetchLimits();
	try {
		const browser = await puppeteer.launch({
			headless: true,
			// Explicit path when we found one; otherwise let puppeteer resolve the
			// system Chrome install itself via the "chrome" channel.
			...(executablePath ? { executablePath } : { channel: "chrome" as const }),
			userDataDir: profile,
			env: chromeEnv(profile),
			args: [...CHROME_ARGS],
		});
		try {
			const page = await browser.newPage();
			await page.setRequestInterception(true);
			page.on("request", (req) => {
				const frame = req.frame();
				const mainFrameNavigation = req.isNavigationRequest() && (frame === null || frame === page.mainFrame());
				const decision = demoRequestDecision(req.url(), documentUrl, mainFrameNavigation);
				if (decision === "continue") void req.continue().catch(() => {});
				else if (decision === "abort") void req.abort("blockedbyclient").catch(() => {});
				else void fulfilThroughGuard(req, pageLife.signal, fetchLimits);
			});
			return await fn(page);
		} finally {
			pageLife.abort();
			await browser.close().catch(() => {});
		}
	} finally {
		fs.rmSync(profile, { recursive: true, force: true });
	}
}

/** A temp dir per invocation; removed in finally. */
function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── Demo execution ──────────────────────────────────────────────────────────

async function runDemo(html: string, opts: RunDemoOptions = {}): Promise<DemoRunResult> {
	const settleMs = opts.settleMs ?? 2000;
	const dir = tempDir("lh-demo-");
	const file = path.join(dir, "demo.html");
	fs.writeFileSync(file, html, "utf-8");

	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	let probeResult: unknown;
	let probed = false;

	const demoUrl = pathToFileURL(file).href;
	try {
		await withBrowserPage(demoUrl, async (page) => {
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});
		page.on("pageerror", (err) => pageErrors.push(err instanceof Error ? err.message : String(err)));
		page.on("requestfailed", (req) => failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? "failed"})`));
		// Interception aborts any navigation away; this is the second line:
		// once the main frame has shown anything but the demo, no probe.
		let leftDemo = false;
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame() && withoutHash(frame.url()) !== withoutHash(demoUrl)) leftDemo = true;
		});

		try {
			await page.goto(demoUrl, { waitUntil: "load", timeout: 30_000 });
			await new Promise((resolve) => setTimeout(resolve, settleMs));
			if (opts.probe) {
				if (leftDemo || withoutHash(page.url()) !== withoutHash(demoUrl)) {
					pageErrors.push(
						"probe not run: the page navigated away from the demo document. Verification blocks every navigation " +
							"away from the demo, so a form submit, a link or a download link that navigates the page breaks it: " +
							"keep the demo on one page (handle forms and links in script, without navigating).",
					);
				} else {
					try {
						probeResult = await page.evaluate(opts.probe);
					} catch (err) {
						pageErrors.push(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					probed = true;
				}
			}
		} catch (err) {
			pageErrors.push(err instanceof Error ? err.message : String(err));
		}
		});
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}

	return {
		consoleErrors,
		pageErrors,
		failedRequests,
		...(probed ? { probeResult } : {}),
		ok: consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
	};
}

// ─── SVG rasterization ───────────────────────────────────────────────────────

function svgViewport(svg: string, opts: RenderSvgOptions): { width: number; height: number } {
	if (opts.width && opts.height) return { width: opts.width, height: opts.height };
	const width = Number(svg.match(/\bwidth\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	const height = Number(svg.match(/\bheight\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	return {
		width: Math.ceil(Number.isFinite(width) && width > 0 ? width : 900),
		height: Math.ceil(Number.isFinite(height) && height > 0 ? height : 700),
	};
}

/** Canonicalize a raw Chrome screenshot for the model's eyes (2026-09-19 fix).
 *
 *  WHY: Chrome writes PNGs with a SPLIT IDAT stream (4KB chunks) — and
 *  Alibaba's vision decoder (behind OpenRouter's qwen3.8-flash, the
 *  visual-maker's look-model) rejected those outright during the
 *  2026-09-18/19 window: "The image format is illegal and cannot be opened",
 *  deterministically, at every size (50–800px) — while every single-IDAT
 *  form passed (a handcrafted 1×1, and sharp re-encodes). On a later re-test
 *  raw Chrome PNGs passed too (the upstream decoder was fixed or is flaky
 *  per backend), but the canonical form stays: PNG spec says the IDAT chunks
 *  are an arbitrary SPLIT of one zlib stream, so merging them is the more
 *  standard shape, byte-identical stream, zero re-encoding.
 *
 *  Pure Node on purpose (no sharp): historically the process already carried
 *  a native image lib via @huggingface/transformers' nested sharp + libvips,
 *  and importing the root sharp (Next's optional dependency) put a SECOND
 *  libvips into the process — macOS's ObjC runtime warns (duplicate
 *  GNotificationCenterDelegate, "mysterious crashes"). The transformers
 *  embedder died with wave 6 (2026-09-23) but the rule lives on: one native
 *  image lib per process; app code carries none. */
export function providerSafePng(png: Buffer): Buffer {
	const SIG_LEN = 8;
	if (png.length < SIG_LEN + 12 || png.subarray(0, SIG_LEN).toString("hex") !== "89504e470d0a1a0a") return png;
	// Walk the chunks once, merging the IDAT split into its canonical
	// single-chunk form (first IDAT's position, concatenated payload).
	const parts: Array<{ type: string; data: Buffer }> = [];
	let off = SIG_LEN;
	while (off + 12 <= png.length) {
		const len = png.readUInt32BE(off);
		if (off + 12 + len > png.length) break; // truncated tail — leave as-is
		parts.push({ type: png.subarray(off + 4, off + 8).toString("ascii"), data: png.subarray(off + 8, off + 8 + len) });
		off += 12 + len;
	}
	const idats = parts.filter((p) => p.type === "IDAT");
	if (idats.length < 2) return png; // already canonical
	const merged = Buffer.concat(idats.map((p) => p.data));
	let emittedIdat = false;
	const out: Buffer[] = [png.subarray(0, SIG_LEN)];
	for (const p of parts) {
		if (p.type !== "IDAT") out.push(chunk(p.type, p.data));
		else if (!emittedIdat) {
			out.push(chunk("IDAT", merged));
			emittedIdat = true;
		}
	}
	return Buffer.concat(out);
}

/** One PNG chunk (length + type + data + CRC32) — the spec's exact layout. */
function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** CRC-32 (PNG's polynomial, table-less) for chunk checksums. */
function crc32(buf: Buffer): number {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

/** resvg resolves an <image>/<feImage> href from the local filesystem (absolute
 *  paths, and relative ones against the working directory) and exposes no
 *  option to stop it. The render goes back to the model as "what the figure
 *  looks like", so model-written markup must not pull a local file into it,
 *  and the learner's <img> view never loads one. Every href-named attribute
 *  (any element, any namespace prefix: the XML parser resolves prefixes, so
 *  the element name is not a safe filter) survives only as a same-document
 *  "#id" or an inline data:image/ source; anything else is removed. Entity
 *  references and other spellings fail the allow-list and are dropped too.
 *  Applied to the render input only, after the display repairs. */
function withoutExternalReferences(svg: string): string {
	return svg.replace(
		/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<\/?[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>/g,
		(token) => {
			if (!/^<[a-zA-Z]/.test(token)) return token;
			return token.replace(/\s([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, (attr, name: string, raw: string) => {
				if (name.split(":").pop() !== "href") return attr;
				const value = raw.replace(/^["']|["']$/g, "").trim();
				// A space, not nothing: deleting must never glue the neighbours together.
				return value.startsWith("#") || /^data:image\//i.test(value) ? attr : " ";
			});
		},
	);
}

/** The rule, applied to the exact text handed to resvg and tokenizing nothing:
 *  every occurrence of `href`, optional whitespace, `=` anywhere in the text
 *  (comments, CDATA and displayed text included) must be followed by a quoted
 *  value that, trimmed, is empty, starts with "#", or is an inline image of a
 *  known type (data:image/<type>; or data:image/<type>,). Returns the offset of
 *  the `=` of each occurrence that breaks the rule. */
function unacceptableHrefs(text: string): number[] {
	const bad: number[] = [];
	for (const match of text.matchAll(/href\s*=/gi)) {
		const eq = match.index + match[0].length - 1;
		const value = /^\s*(["'])([\s\S]*?)\1/.exec(text.slice(eq + 1))?.[2]?.trim();
		const ok = value !== undefined && (value === "" || value.startsWith("#") || /^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml)[;,]/i.test(value));
		if (!ok) bad.push(eq);
	}
	return bad;
}

const DOCTYPE_LITERAL = String.raw`(?:"[^<>\[\]"']*"|'[^<>\[\]"']*')`;
const PLAIN_DOCTYPE = new RegExp(
	String.raw`^\uFEFF?\s*(?:<\?xml[^<>]*\?>\s*)?<!DOCTYPE\s+[A-Za-z_:][\w:.-]*(?:\s+PUBLIC\s+${DOCTYPE_LITERAL}\s+${DOCTYPE_LITERAL}|\s+SYSTEM\s+${DOCTYPE_LITERAL})?\s*>`,
	"i",
);

/** Last gate before resvg, on the exact string it will parse (so it holds
 *  whatever the rewriting above did, and the tokenizer above and the XML
 *  parser may disagree). Entities cannot be declared and a DOCTYPE may only be
 *  one plain declaration at the start, so an attribute name can only appear
 *  literally; then each unacceptable `href=` has its `=` turned into `&#61;`
 *  (identical in text content and in another attribute's value, not
 *  well-formed inside a tag, so the render fails there), and a final scan
 *  throws if anything unacceptable is left. */
function guardedRenderSource(text: string): string {
	if (/<!(?:ENTITY|ATTLIST)/i.test(text)) throw new Error("SVG not rendered: remove the <!ENTITY …> / <!ATTLIST …> declarations; entities are not supported in figures");
	const declared = /<!DOCTYPE/i.test(text);
	let rest = text;
	if (declared) {
		const doctype = PLAIN_DOCTYPE.exec(text);
		if (!doctype) throw new Error("SVG not rendered: remove the DOCTYPE (or keep only a plain <!DOCTYPE svg> / PUBLIC … / SYSTEM … line at the very start, with no [ … ] subset)");
		rest = text.slice(doctype[0].length);
		if (/<!DOCTYPE/i.test(rest)) throw new Error("SVG not rendered: remove the extra DOCTYPE; only one plain declaration at the start is allowed");
	}
	let out = text;
	for (const eq of unacceptableHrefs(text).reverse()) out = `${out.slice(0, eq)}&#61;${out.slice(eq + 1)}`;
	if (unacceptableHrefs(out).length > 0) throw new Error("SVG not rendered: an href may only point to #id or an inline data:image/ address");
	return out;
}

async function renderSvg(svg: string, opts: RenderSvgOptions = {}): Promise<Buffer> {
	// Static native rasterization only: resvg draws in-process, so model-written
	// SVG is never opened in a browser. The same two render-only repairs as the
	// learner's display are applied first (svgImageSource), so a figure that
	// displays fine also renders; the caller's source is not rewritten. Local
	// file references are then stripped (withoutExternalReferences). A native
	// error propagates to the visual-maker's revise/fail loop, with no Chrome
	// fallback. White background mirrors the old Chrome page; fitTo width mirrors
	// svgViewport semantics (attrs win, viewBox-only gets the 900 default,
	// opts override).
	const { width } = svgViewport(svg, opts);
	const { Resvg } = await import("@resvg/resvg-js");
	const resvg = new Resvg(guardedRenderSource(withoutExternalReferences(svgImageSource(svg))), {
		fitTo: { mode: "width", value: width },
		font: { loadSystemFonts: true },
		background: "#ffffff",
	});
	return providerSafePng(resvg.render().asPng());
}

// ─── PDF page rasterization (pdfjs paints, Skia hosts) ─────────────────

/** Render PDF pages to PNGs — the sources-v0 pdf-reader's eyes.
 *
 *  History: pdfjs ALWAYS painted the pages (scale = dpi/72, the skill's
 *  zoom arithmetic) — first inside a headless Chrome tab (canvas shim,
 *  toDataURL, 2026-09-19), now into @napi-rs/canvas in this process (Wave
 *  E, 2026-10-10). The paint engine never changed; only the canvas host:
 *  Skia in-process via pdfjs-dist v6's own Node integration. No browser,
 *  no temp files, no base64 hop. */
async function renderPdfPages(
	pdfPath: string,
	pages: number[],
	opts: RenderPdfOptions = {},
): Promise<RenderedPdfPage[]> {
	const dpi = opts.dpi ?? 150;
	// NATIVE CANVAS (Wave E, owner 2026-10-10): pdfjs paints into
	// @napi-rs/canvas in this process — no browser involved. pdfjs-dist v6's
	// own Node integration IS @napi-rs/canvas (its optionalDependency: the
	// NodeCanvasFactory requires it), so the paint engine is the exact code
	// that used to run in the Chrome shim tab; only the canvas host changed
	// (Skia in-process instead of a DOM canvas). Text-side pdf tools never
	// needed a browser; now renders don't either.
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const { createCanvas } = await import("@napi-rs/canvas");
	const data = new Uint8Array(fs.readFileSync(path.resolve(pdfPath)));
	// Standard-font data as a directory path (live-smoke finding 2026-09-19:
	// without it pdfjs renders non-embedded standard fonts via fallback);
	// verbosity 0 = errors only (JBIG2 noise on scanned PDFs).
	const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const doc = await loadingTask.promise;
	try {
		const out: RenderedPdfPage[] = [];
		for (const pageNo of pages) {
			if (pageNo < 1 || pageNo > doc.numPages) continue;
			const pg = await doc.getPage(pageNo);
			const vp = pg.getViewport({ scale: dpi / 72 });
			const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
			const ctx = canvas.getContext("2d");
			// pdfjs's render types speak the DOM context; @napi-rs/canvas's
			// context is the same 2D API implemented over Skia.
			await pg.render({
				canvasContext: ctx as unknown as CanvasRenderingContext2D,
				canvas: canvas as unknown as HTMLCanvasElement,
				viewport: vp,
			}).promise;
			out.push({
				page: pageNo,
				// Skia-encoded PNG → providerSafePng for the same single-IDAT
				// canonical form every other vision-model image gets.
				png: providerSafePng(canvas.toBuffer("image/png")),
			});
		}
		return out;
	} finally {
		await loadingTask.destroy().catch(() => {});
	}
}

// ─── the real API ────────────────────────────────────────────────────────────

export const realHeadless: HeadlessApi = {
	available() {
		return resolveChromeExecutablePath() !== null;
	},
	unavailableReason() {
		return resolveChromeExecutablePath() === null ? NO_CHROME_MESSAGE : null;
	},
	runDemo,
	renderSvg,
	renderPdfPages,
};
