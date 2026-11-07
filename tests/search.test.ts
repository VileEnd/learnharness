/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEARCH_ENGINES } from "../src/core/search.ts";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, exaProvider } from "../src/server/search.ts";

describe("SEARCH_ENGINES (the engine table)", () => {
	it("is the automatic preference order, each row with its key env var", () => {
		assert.deepEqual(SEARCH_ENGINES.map((e) => [e.id, e.envVar]), [
			["tavily", "TAVILY_API_KEY"],
			["brave", "BRAVE_API_KEY"],
			["exa", "EXA_API_KEY"],
		]);
	});
});

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("all keys, no pin: Tavily, then Brave, then Exa as keys go away", () => {
		const keys = { tavily: "tvly-throwaway-key-00001", brave: "brave-throwaway-key-00001", exa: "exa-throwaway-key-00001" };
		assert.equal(resolveSearchEngineFor(undefined, keys).engine, "tavily");
		assert.equal(resolveSearchEngineFor(undefined, { brave: keys.brave, exa: keys.exa }).engine, "brave");
		assert.equal(resolveSearchEngineFor(undefined, { exa: keys.exa }).engine, "exa");
		assert.equal(resolveSearchEngineFor("exa", keys).engine, "exa", "a pin beats the auto order");
	});

	it("a pinned Exa without its key is unavailable (no fallback) and names the key", () => {
		const out = resolveSearchEngineFor("exa", { tavily: "tvly-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.match(out.reason, /EXA_API_KEY/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("reports the status only: the error body never reaches the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "bad key tvly-throwaway-key-00001" } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), (err: Error) => err.message === "Tavily search API 401");
	});

	it("maps invalid JSON to a fixed message without the body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () => new Response("<html>secret-body</html>", { status: 200 }));
		await assert.rejects(provider.search("q", 5), (err: Error) => err.message === "Tavily search API returned an invalid response");
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("reports the status only: the error body never reaches the message", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited for brave-throwaway-key-00001", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), (err: Error) => err.message === "Brave search API 429");
	});

	it("maps invalid JSON to a fixed message without the body", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () => new Response("<html>secret-body</html>", { status: 200 }));
		await assert.rejects(provider.search("q", 5), (err: Error) => err.message === "Brave search API returned an invalid response");
	});
});

describe("exaProvider (api.exa.ai/search, x-api-key, type auto, highlights)", () => {
	it("POSTs the documented body and maps highlights, text fallback and titles", async () => {
		const provider = exaProvider("exa-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", highlights: ["one\ntwo", "three"] },
					{ url: "https://example.com/b", text: "body   text" },
					{ title: "Not http", url: "javascript:alert(1)", highlights: ["x"] },
					{ title: "No URL", highlights: ["x"] },
				],
				costDollars: { total: 0.007 },
			},
			(url, init) => {
				assert.equal(url, "https://api.exa.ai/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-api-key"], "exa-throwaway-key-00001");
				assert.deepEqual(JSON.parse(init.body as string), { query: "test query", type: "auto", numResults: 5, contents: { highlights: true } });
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [
			{ title: "Example", url: "https://example.com/a", snippet: "one two three" },
			{ title: "https://example.com/b", url: "https://example.com/b", snippet: "body text" },
		]);
	});

	it("reports the status only: the error body never reaches the message", async () => {
		const provider = exaProvider("exa-throwaway-key-00001", async () => new Response("bad key exa-throwaway-key-00001", { status: 401 }));
		await assert.rejects(provider.search("q", 5), (err: Error) => err.message === "Exa search API 401");
	});

	it("maps invalid JSON and a missing results array to a fixed message", async () => {
		const html = exaProvider("exa-throwaway-key-00001", async () => new Response("<html>secret-body</html>", { status: 200 }));
		await assert.rejects(html.search("q", 5), (err: Error) => err.message === "Exa search API returned an invalid response");
		const noResults = exaProvider("exa-throwaway-key-00001", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
		await assert.rejects(noResults.search("q", 5), (err: Error) => err.message === "Exa search API returned an invalid response");
	});
});
