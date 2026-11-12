/**
 * The demo-verification browser is locked down: the model writes the demo
 * and the probe, and the probe's value goes back to the model, so the page
 * must not read local files or reach the app's network. The request decision
 * is unit-tested; the integration tests drive a real Chromium against temp
 * files and a loopback server, and run only when CHROME_PATH is set.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { outboundOverride } from "../src/agent/outbound.ts";
import {
	createPageFetchLimits,
	demoRequestDecision,
	fulfilThroughGuard,
	realHeadless,
} from "../src/agent/subagents/headless.ts";

const CHROME = process.env.CHROME_PATH;
const skip = CHROME ? false : "CHROME_PATH is not set";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
	outboundOverride.current = undefined;
});

describe("demo request decision", () => {
	it("lets data: and blob: through and fetches http(s) through the guard", () => {
		assert.equal(demoRequestDecision("data:text/javascript,1", false), "continue");
		assert.equal(demoRequestDecision("blob:null/0b6c2f0e-0000-4000-8000-000000000000", false), "continue");
		assert.equal(demoRequestDecision("https://cdn.example.com/lib.js", false), "fetch");
		assert.equal(demoRequestDecision("http://cdn.example.com/lib.js", false), "fetch");
	});

	it("aborts files, other schemes and every main-frame navigation (the demo is in memory, never a request)", () => {
		for (const url of [
			"file:///etc/hostname",
			"file:///tmp/lh-demo-x/",
			"file:///tmp/lh-demo-x/demo.html",
			"ftp://example.com/x",
			"chrome://version",
			"view-source:https://example.com/",
			"ws://example.com/",
		]) {
			assert.equal(demoRequestDecision(url, false), "abort", url);
		}
		for (const url of ["https://example.com/", "file:///etc/hostname", "data:text/html,x", "about:blank"]) {
			assert.equal(demoRequestDecision(url, true), "abort", url);
		}
	});
});

describe("page fetch limits (bounded memory in the shared server)", () => {

	/** A stand-in for an intercepted request: records how it was resolved. */
	function fakeRequest(url: string) {
		const req = {
			outcome: "",
			url: () => url,
			method: () => "GET",
			headers: () => ({}),
			respond: async (r: { body?: string | Uint8Array }) => {
				req.outcome = `respond ${r.body?.length ?? 0}`;
			},
			abort: async (code?: string) => {
				req.outcome = `abort ${code}`;
			},
		};
		return req;
	}

	it("runs at most a few guarded fetches at once and refuses the overflow", async () => {
		let active = 0;
		let peak = 0;
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		outboundOverride.current = {
			lookup: async () => [{ address: "192.0.2.10", family: 4 }],
			fetch: async () => {
				peak = Math.max(peak, ++active);
				await gate;
				active--;
				return new Response("x");
			},
		};
		const limits = createPageFetchLimits({ maxConcurrent: 6, maxQueued: 20 });
		const reqs = Array.from({ length: 40 }, (_, i) => fakeRequest(`https://cdn.example.com/${i}.js`));
		const runs = reqs.map((r) => fulfilThroughGuard(r, new AbortController().signal, limits));
		await new Promise((resolve) => setTimeout(resolve, 20));
		open();
		await Promise.all(runs);
		assert.equal(peak, 6);
		assert.equal(reqs.filter((r) => r.outcome === "respond 1").length, 26);
		assert.equal(reqs.filter((r) => r.outcome === "abort blockedbyclient").length, 14);
	});

	it("stops serving once the run's byte budget is spent", async () => {
		outboundOverride.current = {
			lookup: async () => [{ address: "192.0.2.10", family: 4 }],
			fetch: async () => new Response(new Uint8Array(600)),
		};
		const limits = createPageFetchLimits({ maxBytes: 1000 });
		const reqs = [1, 2, 3].map((i) => fakeRequest(`https://cdn.example.com/big-${i}.bin`));
		for (const r of reqs) await fulfilThroughGuard(r, new AbortController().signal, limits);
		assert.deepEqual(reqs.map((r) => r.outcome), ["respond 600", "abort blockedbyclient", "abort blockedbyclient"]);
	});
});

describe("demo browser against a real Chromium", { skip }, () => {
	function tempSecret(): { url: string; marker: string } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lockdown-"));
		dirs.push(dir);
		const marker = `LOCKDOWN-MARKER-${Math.random().toString(36).slice(2)}`;
		const file = path.join(dir, "secret.txt");
		fs.writeFileSync(file, marker);
		return { url: pathToFileURL(file).href, marker };
	}

	it("a demo that navigates to a local file cannot read it through the probe", async () => {
		const secret = tempSecret();
		const html = `<!doctype html><p>demo</p><script>
			addEventListener("load", () => { location.href = ${JSON.stringify(secret.url)}; });
		</script>`;
		const result = await realHeadless.runDemo(html, {
			settleMs: 800,
			probe: "document.documentElement.innerText",
		});
		assert.ok(!JSON.stringify(result).includes(secret.marker), JSON.stringify(result));
		// From a blank in-memory page Chromium refuses the file: navigation itself
		// (a console error); the page stays the demo, and verification fails.
		assert.equal(result.ok, false);
		assert.match(result.consoleErrors.join("\n"), /Not allowed to load local resource/);
	});

	it("a demo that uses browser storage fails verification, as it fails in the learner's sandboxed frame", async () => {
		const uses: Record<string, string> = {
			localStorage: `localStorage.setItem("k", "v");`,
			sessionStorage: `sessionStorage.setItem("k", "v");`,
			cookie: `document.cookie = "k=v";`,
			indexedDB: `indexedDB.open("db");`,
		};
		for (const [api, code] of Object.entries(uses)) {
			const result = await realHeadless.runDemo(`<!doctype html><p>demo</p><script>${code}</script>`, { settleMs: 200 });
			assert.equal(result.ok, false, `${api}: ${JSON.stringify(result)}`);
			const errors = result.pageErrors.join("\n");
			assert.match(errors, /opaque origin/, `${api}: ${errors}`);
			assert.match(errors, /localStorage, sessionStorage, IndexedDB and cookies/, `${api}: ${errors}`);
		}
	});

	it("a demo that guards its storage use still passes, and runs on an opaque origin", async () => {
		const html = `<!doctype html><p>demo</p><script>
			window.saved = "none";
			try { localStorage.setItem("k", "v"); window.saved = "stored"; } catch { window.saved = "unavailable"; }
		</script>`;
		const result = await realHeadless.runDemo(html, { settleMs: 200, probe: "({ origin: location.origin, saved })" });
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(result.probeResult, { origin: "null", saved: "unavailable" });
	});

	it("a demo that navigates the top page anywhere, or reloads it, is refused and never probed", async () => {
		const moves = [
			`location.href = "about:blank";`,
			`location.reload();`,
			`location.href = "https://cdn.example.com/page";`,
			`top.location = "https://cdn.example.com/page";`,
			`document.head.innerHTML += '<meta http-equiv="refresh" content="0;url=https://cdn.example.com/page">';`,
			`const f = document.createElement("form"); f.action = "https://cdn.example.com/post"; document.body.appendChild(f); f.submit();`,
		];
		for (const move of moves) {
			const html = `<!doctype html><p>demo</p><script>addEventListener("load", () => { ${move} });</script>`;
			const result = await realHeadless.runDemo(html, { settleMs: 800, probe: "document.documentElement.innerText" });
			assert.equal(result.ok, false, move);
			assert.equal(result.probeResult, undefined, `${move}: ${JSON.stringify(result)}`);
			assert.match(result.pageErrors.join("\n"), /probe not run: .*form submit, a link, a download link or a page that reloads itself/, move);
		}
	});

	it("a navigation Chromium refuses by itself from the blank page (data:, file:) fails verification and leaves the demo in place", async () => {
		const secret = tempSecret();
		for (const target of ["data:text/html,<p>other</p>", secret.url]) {
			const html = `<!doctype html><p>demo</p><script>addEventListener("load", () => { location.href = ${JSON.stringify(target)}; });</script>`;
			const result = await realHeadless.runDemo(html, { settleMs: 800, probe: "document.documentElement.innerText" });
			assert.equal(result.ok, false, target);
			assert.equal(result.probeResult, "demo", target);
			assert.ok(!JSON.stringify(result).includes(secret.marker), target);
		}
	});

	it("a demo that only changes its hash is not a navigation away", async () => {
		const html = `<!doctype html><p>demo</p><script>addEventListener("load", () => { location.hash = "#section"; });</script>`;
		const result = await realHeadless.runDemo(html, { settleMs: 400, probe: "document.body.innerText" });
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.probeResult, "demo");
	});

	it("a demo that hangs while loading ends the verification at the load limit, not at the protocol timeout", { timeout: 60_000 }, async () => {
		const started = Date.now();
		const result = await realHeadless.runDemo(`<!doctype html><p>demo</p><script>while (true) {}</script>`, { settleMs: 200 });
		assert.ok(Date.now() - started < 50_000, `took ${Date.now() - started} ms`);
		assert.equal(result.ok, false);
		assert.match(result.pageErrors.join("\n"), /did not finish loading within 30 s \(an endless loop while loading\?\)/);
	});

	it("a demo that needs a secure-context API fails with a hint it can act on", async () => {
		const uses: Record<string, string> = {
			"crypto.randomUUID": `crypto.randomUUID();`,
			"crypto.subtle": `crypto.subtle.digest("SHA-256", new Uint8Array(1));`,
			"navigator.clipboard": `navigator.clipboard.writeText("x");`,
			"navigator.clipboard.readText": `navigator.clipboard.readText();`,
			caches: `caches.open("c");`,
		};
		for (const [api, code] of Object.entries(uses)) {
			const result = await realHeadless.runDemo(`<!doctype html><p>demo</p><script>${code}</script>`, { settleMs: 200 });
			assert.equal(result.ok, false, api);
			const errors = result.pageErrors.join("\n");
			assert.match(errors, /without secure-context APIs/, `${api}: ${errors}`);
			assert.match(errors, /crypto\.randomUUID, crypto\.subtle, navigator\.clipboard or caches/, `${api}: ${errors}`);
		}
	});

	it("the probe-not-run message names a page that reloads itself", async () => {
		const result = await realHeadless.runDemo(`<!doctype html><script>addEventListener("load", () => history.go(0));</script>`, { settleMs: 800, probe: "1" });
		assert.equal(result.probeResult, undefined);
		assert.match(result.pageErrors.join("\n"), /location\.reload\(\)`, `history\.go\(0\)`, a meta refresh/);
	});

	it("history.pushState to another path throws and the page stays the demo", async () => {
		const html = `<!doctype html><p>demo</p><script>addEventListener("load", () => { try { history.pushState({}, "", "/other"); } catch (e) { window.pushError = e.name; } });</script>`;
		const result = await realHeadless.runDemo(html, { settleMs: 400, probe: "({ text: document.body.innerText, pushError })" });
		assert.deepEqual(result.probeResult, { text: "demo", pushError: "SecurityError" });
	});

	it("document.open and write rewrite the same document: the probe reads the rewritten page", async () => {
		const html = `<!doctype html><p>demo</p><script>addEventListener("load", () => { document.open(); document.write("<p>rewritten</p>"); document.close(); });</script>`;
		const result = await realHeadless.runDemo(html, { settleMs: 400, probe: "document.body.innerText" });
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.probeResult, "rewritten");
	});

	it("a nested frame that navigates the top page is refused and the probe does not run", async () => {
		const html = `<!doctype html><p>demo</p><iframe srcdoc="<script>top.location = 'https://cdn.example.com/page';</script>"></iframe>`;
		const result = await realHeadless.runDemo(html, { settleMs: 800, probe: "document.body.innerText" });
		assert.equal(result.ok, false);
		assert.equal(result.probeResult, undefined, JSON.stringify(result));
		assert.match(result.pageErrors.join("\n"), /probe not run/);
	});

	it("a navigation fired from beforeunload is refused and the probe does not run", async () => {
		const html = `<!doctype html><p>demo</p><script>
			addEventListener("beforeunload", () => { location.href = "https://cdn.example.com/page"; });
			addEventListener("load", () => { location.reload(); });
		</script>`;
		const result = await realHeadless.runDemo(html, { settleMs: 800, probe: "document.body.innerText" });
		assert.equal(result.ok, false);
		assert.equal(result.probeResult, undefined, JSON.stringify(result));
		assert.match(result.pageErrors.join("\n"), /probe not run/);
	});

	it("a demo cannot fetch, frame or open a socket to the app's network, and public https still loads", async () => {
		const secret = tempSecret();
		const hits: string[] = [];
		const server = http.createServer((req, res) => {
			hits.push(req.url ?? "");
			res.end("internal");
		});
		server.on("upgrade", (req, socket) => {
			hits.push(req.url ?? "");
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		// The one public script the demo loads is served by the injected
		// transport (no network); the guard still checks its host.
		outboundOverride.current = {
			lookup: async () => [{ address: "192.0.2.10", family: 4 }],
			fetch: async (req) =>
				new Response(req.url.pathname === "/lib.js" ? "window.libLoaded = true;" : "", {
					headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" },
				}),
		};
		const html = `<!doctype html><body><script src="https://cdn.example.com/lib.js"></script><script>
			window.seen = [];
			fetch("http://127.0.0.1:${port}/fetch").then((r) => r.text()).then((t) => seen.push(t), () => seen.push("fetch blocked"));
			fetch(${JSON.stringify(secret.url)}).then((r) => r.text()).then((t) => seen.push(t), () => seen.push("file blocked"));
			try { new WebSocket("ws://127.0.0.1:${port}/ws"); } catch {}
			const f = document.createElement("iframe"); f.src = "http://localhost:${port}/frame"; document.body.appendChild(f);
			const img = new Image(); img.src = "http://127.0.0.1:${port}/img";
			window.open("http://127.0.0.1:${port}/popup");
		</script></body>`;
		try {
			const result = await realHeadless.runDemo(html, { settleMs: 1000, probe: "({ lib: window.libLoaded === true, seen })" });
			assert.deepEqual(hits, [], "nothing reached the loopback server");
			const probe = result.probeResult as { lib: boolean; seen: string[] };
			assert.equal(probe.lib, true, "the public script loaded through the guard");
			assert.ok(!JSON.stringify(result).includes(secret.marker));
			assert.ok(!probe.seen.includes("internal"));
		} finally {
			server.close();
		}
	});
});
