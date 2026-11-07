/**
 * Exa search through the real composition: the key, the engine resolution,
 * the logged request and the month total. Fake keys, stubbed fetch, isolated
 * LH_DATA_DIR / LH_AUTH_FILE (dynamic imports).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import type { RequestLogLine } from "../src/core/contracts/usage.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exa-cost-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
for (const name of ["TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY"]) delete process.env[name];

const { saveKey, deleteKey } = await import("../src/server/keys.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { searchProvider } = await import("../src/server/search.ts");
const { setRequestSink } = await import("../src/agent/request-log.ts");
const { stores } = await import("../src/server/stores.ts");
const { spentThisMonth } = await import("../src/server/model-gate.ts");
const { monthSpend } = await import("../src/server/usage.ts");
const { monthKey, summarizeMonth } = await import("../src/core/usage.ts");
const realFetch = globalThis.fetch;

let lines: RequestLogLine[] = [];
beforeEach(() => {
	lines = [];
	setRequestSink((line) => {
		lines.push(line);
		stores.requestLog.append(line);
	});
	for (const name of ["TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY"]) deleteKey(name);
	writeSettings({ version: 1 });
});
after(() => {
	setRequestSink(null);
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

const exaBody = { results: [{ title: "T", url: "https://example.org/a", highlights: ["h1", "h2"] }], costDollars: { total: 0.007 } };

it("an Exa search is a priced search line that counts toward the month total", async () => {
	assert.equal(saveKey("EXA_API_KEY", "exa-fake-key-1234567890").ok, true);
	globalThis.fetch = (async () => Response.json(exaBody)) as typeof fetch;
	const hits = await searchProvider("chat1")!.search("q", 3);
	assert.equal(hits.length, 1);
	assert.equal(lines.length, 1);
	assert.equal(lines[0]!.purpose, "search");
	assert.equal(lines[0]!.category, "search");
	assert.equal(lines[0]!.provider, "exa");
	assert.equal(lines[0]!.chatId, "chat1");
	assert.equal(lines[0]!.providerCostUsd, 0.007);

	assert.equal(spentThisMonth().usd, 0.007);
	assert.deepEqual(monthSpend(), { usd: 0.007, unpriced: 0 });
	const month = monthKey(new Date());
	const summary = summarizeMonth(month, stores.requestLog.readMonth(month), () => null);
	assert.equal(summary.categories.search.usd, 0.007);
	assert.equal(summary.totalUsd, 0.007);
});

it("Tavily and Brave searches stay unpriced and raise no unpriced warning", async () => {
	const before = monthSpend();
	for (const [name, key, id] of [
		["TAVILY_API_KEY", "tvly-fake-key-1234567890", "tavily"],
		["BRAVE_API_KEY", "brave-fake-key-1234567890", "brave"],
	] as const) {
		assert.equal(saveKey(name, key).ok, true);
		writeSettings({ version: 1, agent: { search: { engine: id } } });
		globalThis.fetch = (async () => Response.json({ results: [], web: { results: [] }, costDollars: { total: 5 } })) as typeof fetch;
		await searchProvider()!.search("q", 3);
		assert.equal(lines.at(-1)!.provider, id);
		assert.equal(lines.at(-1)!.providerCostUsd, undefined);
	}
	assert.deepEqual(monthSpend(), before, "unchanged by the two unpriced search lines");
});
