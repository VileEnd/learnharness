/**
 * Import the demo dependency graph from ONLY a standalone payload. With --browser,
 * also launch the system Chromium (CHROME_PATH, as the demo builder does) with
 * the demo builder's flags and minimal environment, check the flags arrived
 * intact, drive one interactive page through it (loaded in memory, as the demo
 * builder loads a demo: opaque origin, no browser storage, no local file), and
 * prove the network backstop: a page's WebSocket and popup never reach a
 * loopback listener.
 * No server, model, keys, app UI, or production diagnostic route needed.
 *
 * node scripts/smoke-demo-runtime.mjs --standalone <dir> [--runtime <node binary>] [--browser]
 * --runtime defaults to host Node.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The demo builder's Chromium launch flags and environment allowlist: copies
 * of CHROME_ARGS and CHROME_ENV_KEYS in src/agent/subagents/headless.ts (this
 * script runs alone in the image and cannot import the app's TypeScript);
 * tests/demo-runtime-payload.test.ts keeps the copies equal.
 */
export const CHROME_ARGS = [
	"--disable-gpu",
	"--no-sandbox",
	"--disable-dev-shm-usage",
	"--proxy-server=http://0.0.0.0:0",
	"--proxy-bypass-list=<-loopback>",
	"--host-resolver-rules=MAP * ~NOTFOUND",
	"--webrtc-ip-handling-policy=disable_non_proxied_udp",
];
export const CHROME_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "SYSTEMROOT", "WINDIR"];

/** The demo builder's chromeEnv: only the allowlisted keys, HOME and the XDG
 *  dirs on the profile. @param {Record<string, string | undefined>} env @param {string} profile @returns {Record<string, string>} */
export function chromeEnv(env, profile) {
	/** @type {Record<string, string>} */
	const out = { HOME: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile };
	for (const key of CHROME_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** @param {Record<string, string | undefined>} env @param {string} home @returns {Record<string, string | undefined>} */
export function probeEnv(env, home) {
	const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
		!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) &&
		!/^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_)/.test(key) &&
		!["NODE_OPTIONS", "NODE_PATH", "LH_DEV_URL", "ELECTRON_RUN_AS_NODE"].includes(key)));
	return {
		...clean,
		HOME: home, USERPROFILE: home,
		APPDATA: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local"),
		XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
		LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1", NODE_ENV: "production",
	};
}

// Keep fetch's nested cause (including AggregateError socket failures), but
// never dump arbitrary error properties such as request headers or environment.
export function formatProbeError(error, depth = 0) {
	if (depth > 5) return "[cause chain truncated]";
	if (!error || typeof error !== "object") return String(error);
	const lines = [typeof error.stack === "string" ? error.stack : `${error.name ?? "Error"}: ${error.message ?? "unknown error"}`];
	for (const field of ["code", "errno", "syscall", "address", "port"]) {
		if (["string", "number"].includes(typeof error[field])) lines.push(`${field}: ${error[field]}`);
	}
	if (error.cause !== undefined) lines.push(`cause: ${formatProbeError(error.cause, depth + 1)}`);
	if (Array.isArray(error.errors)) {
		for (const nested of error.errors.slice(0, 8)) lines.push(`aggregate: ${formatProbeError(nested, depth + 1)}`);
	}
	return lines.join("\n");
}

export function verifyDemoRuntime(standalone, runtime = process.execPath, browser = false) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-runtime-"));
	try {
		fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(standalone), ...(browser ? ["--browser"] : [])], {
			cwd: home,
			env: probeEnv(process.env, home),
			encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024,
		});
		if (result.status !== 0 || result.error) {
			throw new Error(`demo runtime probe failed (${result.error?.message ?? result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		}
		process.stdout.write(result.stdout);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

async function importPayload(standalone) {
	const root = fs.realpathSync(standalone);
	const inside = (file) => {
		const relative = path.relative(root, fs.realpathSync(file));
		assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
			`dependency escaped standalone payload: ${file}`);
	};
	const require = createRequire(path.join(root, "server.js"));
	const entry = require.resolve("puppeteer-core");
	inside(entry); // require.resolve must not silently fall back to checkout node_modules.
	const loaded = new Set();
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (result.url.startsWith("file:")) {
				inside(fileURLToPath(result.url));
				loaded.add(result.url);
			} else {
				assert.ok(result.url.startsWith("node:"), `unexpected dependency URL: ${result.url}`);
			}
			return result;
		},
	});
	try {
		const { default: puppeteer } = await import(pathToFileURL(entry).href);
		assert.equal(typeof puppeteer.connect, "function");
		console.log(`[smoke-demo-runtime] puppeteer-core import ok; ${loaded.size} modules confined to ${root}`);
		return { puppeteer, hooks };
	} catch (error) {
		hooks.deregister();
		throw error;
	}
}

async function browserProbe(puppeteer) {
	const executablePath = process.env.CHROME_PATH;
	assert.ok(executablePath, "--browser requires CHROME_PATH (the image's Chromium)");
	const home = process.env.HOME;
	const profile = path.join(home, "browser-profile");
	fs.mkdirSync(profile, { recursive: true });
	const browser = await puppeteer.launch({
		headless: true,
		executablePath,
		userDataDir: profile,
		// The demo builder's flags and minimal environment
		// (src/agent/subagents/headless.ts), so the image proves its Chromium
		// (a shell wrapper on Debian) starts with exactly these.
		env: chromeEnv(process.env, profile),
		args: CHROME_ARGS,
	});
	try {
		// Every flag must arrive verbatim (the wrapper must pass "MAP * ~NOTFOUND" through intact).
		const session = await browser.target().createCDPSession();
		const { arguments: launched } = await session.send("Browser.getBrowserCommandLine");
		await session.detach().catch(() => {});
		for (const flag of CHROME_ARGS) assert.ok(launched.includes(flag), `Chromium did not receive ${flag}: ${launched.join(" ")}`);

		const page = await browser.newPage();
		const failures = [];
		let canaryRefused = false; // Chromium logs the refused file: fetch as a console error: expected here.
		page.on("console", (msg) => {
			if (msg.type() !== "error") return;
			if (/Not allowed to load local resource/.test(msg.text())) canaryRefused = true;
			else failures.push(msg.text());
		});
		page.on("pageerror", (err) => failures.push(String(err)));
		page.on("requestfailed", (req) => failures.push(`failed request: ${req.url()}`));
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			if (/^(about:|data:)/.test(req.url())) void req.continue();
			else { failures.push(`unexpected network request: ${req.url()}`); void req.abort(); }
		});
		// A canary file the page must not be able to read, and the demo itself,
		// loaded the way the demo builder loads it: into the blank tab, in memory.
		const canary = path.join(home, "canary.txt");
		fs.writeFileSync(canary, "CANARY-DO-NOT-READ");
		await page.setContent(`<!doctype html><meta charset="utf-8"><button id="increment">Increment</button><output id="count">0</output><script>
			document.querySelector("#increment").onclick = () => { document.querySelector("#count").textContent = "1"; };
			window.report = { canary: "not tried", storage: "not tried" };
			fetch(${JSON.stringify(pathToFileURL(canary).href)}).then((r) => r.text()).then((t) => { report.canary = t; }, () => { report.canary = "blocked"; });
			try { localStorage.setItem("k", "v"); report.storage = "stored"; } catch { report.storage = "denied"; }
		</script>`, { waitUntil: "load", timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await page.evaluate(() => location.origin), "null", "the in-memory page must have an opaque origin");
		assert.deepEqual(await page.evaluate(() => window.report), { canary: "blocked", storage: "denied" }, "the in-memory page read a local file or used browser storage");
		assert.ok(canaryRefused, "Chromium did not refuse the page's read of the canary file");
		assert.equal(await page.$eval("#count", (element) => element.textContent), "0");
		await page.click("#increment");
		assert.equal(await page.$eval("#count", (element) => element.textContent), "1");
		assert.deepEqual(failures, [], "demo console/page/network errors");
		console.log(`[smoke-demo-runtime] ${executablePath}: in-memory page, origin null, canary file and storage blocked, JS button 0 → 1, clean console/page`);
		await backstopProbe(browser, home);
	} finally {
		await browser.close().catch(() => {});
	}
}

/** The network backstop the demo builder relies on for what request
 *  interception cannot see: a page with no interception at all opens a
 *  WebSocket, a popup and a fetch to a loopback listener, and the listener
 *  must see no connection. Loopback only, no external network. */
async function backstopProbe(browser, home) {
	let connections = 0;
	const listener = net.createServer((socket) => {
		connections++;
		socket.destroy();
	});
	await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = listener.address();
		const page = await browser.newPage();
		await page.setContent(`<!doctype html><meta charset="utf-8"><script>
			try { new WebSocket("ws://127.0.0.1:${port}/ws"); } catch {}
			try { new WebSocket("ws://localhost:${port}/ws"); } catch {}
			window.open("http://127.0.0.1:${port}/popup");
			fetch("http://127.0.0.1:${port}/fetch").catch(() => {});
		</script>`, { waitUntil: "load", timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		assert.equal(connections, 0, "a demo page reached a loopback listener: the Chromium network backstop is not in effect");
		console.log("[smoke-demo-runtime] network backstop: WebSocket, popup and fetch to loopback all blocked");
	} finally {
		listener.close();
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--probe") {
		const { puppeteer, hooks } = await importPayload(args[1]);
		try {
			if (args.includes("--browser")) await browserProbe(puppeteer);
		} finally { hooks.deregister(); }
		return;
	}
	const value = (name, fallback) => {
		const index = args.indexOf(name);
		if (index < 0) return fallback;
		assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a path`);
		return path.resolve(args[index + 1]);
	};
	verifyDemoRuntime(value("--standalone", path.resolve(import.meta.dirname, "../.next/standalone")), value("--runtime", process.execPath), args.includes("--browser"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => { console.error(`[smoke-demo-runtime] FAIL: ${formatProbeError(err)}`); process.exitCode = 1; });
}
