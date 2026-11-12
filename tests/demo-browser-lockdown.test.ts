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
	const doc = "file:///tmp/lh-demo-x/demo.html";

	it("lets the demo file, data: and blob: through and fetches http(s) through the guard", () => {
		assert.equal(demoRequestDecision(doc, doc, true), "continue");
		assert.equal(demoRequestDecision(`${doc}#section`, doc, true), "continue");
		assert.equal(demoRequestDecision("data:text/javascript,1", doc, false), "continue");
		assert.equal(demoRequestDecision("blob:null/0b6c2f0e-0000-4000-8000-000000000000", doc, false), "continue");
		assert.equal(demoRequestDecision("https://cdn.example.com/lib.js", doc, false), "fetch");
		assert.equal(demoRequestDecision("http://cdn.example.com/lib.js", doc, false), "fetch");
	});

	it("aborts other files, other schemes and any main-frame navigation away from the demo", () => {
		for (const url of [
			"file:///etc/hostname",
			"file:///tmp/lh-demo-x/",
			"file:///tmp/lh-demo-x/other.html",
			"ftp://example.com/x",
			"chrome://version",
			"view-source:https://example.com/",
			"ws://example.com/",
		]) {
			assert.equal(demoRequestDecision(url, doc, false), "abort", url);
		}
		assert.equal(demoRequestDecision("https://example.com/", doc, true), "abort");
		assert.equal(demoRequestDecision("file:///etc/hostname", doc, true), "abort");
		assert.equal(demoRequestDecision("data:text/html,x", doc, true), "abort");
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
		assert.match(result.pageErrors.join("\n"), /probe not run: .*form submit, a link or a download link/);
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
