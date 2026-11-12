/**
 * The outbound guard (src/agent/outbound.ts): model-steered URLs never reach
 * the machine or network the app runs on. The classifier refuses every
 * non-public range, redirects are re-checked per hop, bodies are capped while
 * they stream, the tools honour their abort signal, and the connection goes
 * to the address that was checked. Zero network: lookup and transport are
 * injected; globalThis.fetch is a tripwire where a tool must not reach it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import {
	classifyAddress,
	guardedFetch,
	hostRefusal,
	nodePinnedFetch,
	outboundOverride,
	readCapped,
	type PinnedRequest,
	type ResolvedAddress,
} from "../src/agent/outbound.ts";
import { createPdfReadTools } from "../src/agent/tools/pdf-read.ts";
import { createWebTools } from "../src/agent/tools/web.ts";

const PUBLIC: ResolvedAddress = { address: "192.0.2.10", family: 4 };

const tempDirs: string[] = [];
after(async () => {
	await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});
afterEach(() => {
	outboundOverride.current = undefined;
});

function details(result: unknown): string {
	const d = (result as { details?: unknown }).details;
	return typeof d === "string" ? d : JSON.stringify(d);
}

/** Replace globalThis.fetch with a recorder for the body of `fn`. */
async function withFetchTripwire<T>(fn: (reached: string[]) => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	const reached: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		reached.push(String(input));
		return new Response("internal secret", { headers: { "content-type": "text/plain" } });
	}) as typeof fetch;
	try {
		return await fn(reached);
	} finally {
		globalThis.fetch = real;
	}
}

describe("address classifier", () => {
	it("refuses every non-public IPv4 range", () => {
		for (const ip of [
			"0.0.0.0",
			"10.1.2.3",
			"100.64.0.1",
			"100.127.255.254",
			"127.0.0.1",
			"127.255.0.9",
			"169.254.169.254",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"224.0.0.1",
			"239.255.255.250",
			"255.255.255.255",
		]) {
			assert.ok(classifyAddress(ip), `${ip} must be refused`);
		}
	});

	it("refuses the IPv6 forms, including IPv4 embedded in IPv6", () => {
		for (const ip of [
			"::",
			"::1",
			"fe80::1",
			"fe80::1%eth0",
			"fc00::1",
			"fd12:3456::1",
			"ff02::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"::ffff:10.0.0.1",
			"::ffff:169.254.169.254",
			"64:ff9b::a00:1",
			"2002:c0a8:101::1",
			"[::1]",
		]) {
			assert.ok(classifyAddress(ip), `${ip} must be refused`);
		}
	});

	it("allows a public address in either family", () => {
		assert.equal(classifyAddress("192.0.2.10"), null);
		assert.equal(classifyAddress("203.0.113.7"), null);
		assert.equal(classifyAddress("2001:db8::1"), null);
		assert.equal(classifyAddress("::ffff:192.0.2.10"), null, "a mapped public IPv4 is public");
	});

	it("refuses local names before any lookup and lets a public name through", () => {
		for (const host of ["localhost", "localhost.", "app.localhost", "keycloak", "ocr", "printer.local", "db.internal", "[::1]", "127.0.0.1"]) {
			assert.ok(hostRefusal(host), `${host} must be refused`);
		}
		assert.equal(hostRefusal("example.com"), null);
		assert.equal(hostRefusal("192.0.2.10"), null);
	});
});

describe("guardedFetch", () => {
	it("connects to the address it checked, and refuses a name with any private answer", async () => {
		const seen: PinnedRequest[] = [];
		const deps = {
			lookup: async (host: string): Promise<ResolvedAddress[]> =>
				host === "mixed.example.com" ? [PUBLIC, { address: "10.0.0.5", family: 4 }] : [PUBLIC],
			fetch: async (req: PinnedRequest) => {
				seen.push(req);
				return new Response("ok");
			},
		};
		const { url } = await guardedFetch("https://example.com/a", {}, deps);
		assert.equal(url, "https://example.com/a");
		assert.deepEqual([seen[0]!.addresses, seen[0]!.url.hostname], [[PUBLIC], "example.com"]);
		await assert.rejects(guardedFetch("https://mixed.example.com/", {}, deps), /non-public address/);
		assert.equal(seen.length, 1, "the refused name was never fetched");
	});

	it("the default transport connects to the pinned address, never to a fresh lookup of the name", async () => {
		// The name below has no DNS record; the request still lands on the
		// loopback server it was pinned to, with the name as its Host.
		const server = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
			res.end(gzipSync(`host=${req.headers.host}`));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const port = (server.address() as { port: number }).port;
			const resp = await nodePinnedFetch({
				url: new URL(`http://unresolvable.invalid:${port}/`),
				addresses: [{ address: "127.0.0.1", family: 4 }],
				method: "GET",
				headers: {},
			});
			assert.equal(new TextDecoder().decode(await readCapped(resp, 1024)), `host=unresolvable.invalid:${port}`);
		} finally {
			server.close();
		}
	});

	it("re-checks every redirect hop and caps the hop count", async () => {
		const fetched: string[] = [];
		const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
		const deps = {
			lookup: async (host: string): Promise<ResolvedAddress[]> =>
				host === "rebind.example.com" ? [{ address: "127.0.0.1", family: 4 }] : [PUBLIC],
			fetch: async (req: PinnedRequest) => {
				fetched.push(req.url.href);
				const p = req.url.pathname;
				if (p === "/to-literal") return redirectTo("http://169.254.169.254/latest/meta-data/");
				if (p === "/to-name") return redirectTo("https://rebind.example.com/");
				if (p === "/to-file") return redirectTo("file:///etc/hostname");
				if (p === "/loop") return redirectTo("/loop");
				if (p === "/hop") return redirectTo("/final");
				return new Response("final page");
			},
		};
		await assert.rejects(guardedFetch("https://example.com/to-literal", {}, deps), /not a public host/);
		await assert.rejects(guardedFetch("https://example.com/to-name", {}, deps), /non-public address/);
		await assert.rejects(guardedFetch("https://example.com/to-file", {}, deps), /only http\(s\)/);
		await assert.rejects(guardedFetch("https://example.com/loop", { maxRedirects: 3 }, deps), /Too many redirects/);
		const ok = await guardedFetch("https://example.com/hop", {}, deps);
		assert.equal(ok.url, "https://example.com/final");
		assert.equal(await ok.response.text(), "final page");
		assert.ok(!fetched.some((u) => u.includes("169.254") || u.includes("rebind") || u.startsWith("file:")));
	});

	it("caps a body with no declared length while it streams", async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(1024));
			},
		});
		const resp = new Response(endless);
		assert.equal(resp.headers.get("content-length"), null);
		await assert.rejects(readCapped(resp, 10 * 1024), /Response too large/);
		assert.ok(pulled <= 12, `stopped reading near the cap (pulled ${pulled} chunks)`);
		assert.equal((await readCapped(new Response("small"), 10)).byteLength, 5);
	});
});

describe("the researcher's fetch tools", () => {
	it("web_fetch refuses internal targets and never reaches the network", async () => {
		outboundOverride.current = { lookup: async () => [{ address: "172.18.0.4", family: 4 }] };
		await withFetchTripwire(async (reached) => {
			const { web_fetch } = createWebTools(() => null);
			for (const url of ["http://127.0.0.1:3000/api/health", "http://keycloak:8080/", "http://[::1]/", "https://compose-host.example.com/"]) {
				const out = details(await web_fetch!.execute!("c1", { url }));
				assert.match(out, /refused/, url);
			}
			assert.deepEqual(reached, []);
		});
	});

	it("web_fetch_pdf refuses internal targets and never reaches the network", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-test-outbound-"));
		tempDirs.push(dir);
		await withFetchTripwire(async (reached) => {
			const { web_fetch_pdf } = createPdfReadTools(dir);
			for (const url of ["http://169.254.169.254/x.pdf", "http://ocr:8000/doc.pdf", "http://192.168.1.1/a.pdf"]) {
				const out = details(await web_fetch_pdf!.execute!("c1", { url }));
				assert.match(out, /refused/, url);
			}
			assert.deepEqual(reached, []);
		});
	});

	it("web_fetch caps a body that declares no length", async () => {
		outboundOverride.current = {
			lookup: async () => [PUBLIC],
			fetch: async () => {
				const endless = new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
					},
				});
				return new Response(endless, { headers: { "content-type": "text/plain" } });
			},
		};
		const out = details(await createWebTools(() => null).web_fetch!.execute!("c1", { url: "https://example.com/huge" }));
		assert.match(out, /Response too large/);
	});

	it("aborting the tool aborts its fetch", async () => {
		let started!: () => void;
		const inFlight = new Promise<void>((resolve) => (started = resolve));
		let transportAborted = false;
		outboundOverride.current = {
			lookup: async () => [PUBLIC],
			fetch: (req) =>
				new Promise<Response>((_resolve, reject) => {
					req.signal?.addEventListener("abort", () => {
						transportAborted = true;
						reject(new Error("aborted"));
					});
					started();
				}),
		};
		const parent = new AbortController();
		const run = createWebTools(() => null).web_fetch!.execute!("c1", { url: "https://example.com/slow" }, parent.signal);
		await inFlight;
		parent.abort();
		await run.catch(() => {});
		assert.equal(transportAborted, true);
	});
});
