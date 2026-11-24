/**
 * The model catalog refresh from pi.dev: only new ids on a bundled route are
 * admitted, an invalid row fails the refresh, the POST is admin only, the
 * shared snapshot is overlaid at startup without a fetch, and the daily
 * switch is respected. Isolated LH_DATA_DIR in multi-user mode, so every
 * app-module import is dynamic. pi.dev is a stubbed globalThis.fetch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AUTH_PROVIDER_ENV_VARS } from "../src/core/auth-keys.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-model-refresh-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;
for (const key of AUTH_PROVIDER_ENV_VARS) delete process.env[key];
process.env.OPENAI_API_KEY = "test-key-model-refresh";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { piModels } = await import("../src/agent/models.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const policy = await import("../src/server/policy.ts");
const catalog = await import("../src/server/remote-model-catalog.ts");
const route = await import("../app/api/models/route.ts");

const ADMIN = { id: "admin-a", name: "a", isAdmin: true };
const USER = { id: "user-b", name: "b", isAdmin: false };
const snapshotFile = path.join(dir, "global", "model-catalog.json");

// The feed row reuses a bundled model's exact route, read at runtime.
const bundled = piModels().getModels("openai")[0]!;
const row = {
	id: "test-new-model", name: "Test new model", api: bundled.api, baseUrl: bundled.baseUrl, reasoning: false,
	input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8_000,
};

/** Stub pi.dev: answer every request with `rows`, recording the URLs. */
function stubFeed(rows: unknown[]): string[] {
	const urls: string[] = [];
	globalThis.fetch = async (input) => {
		urls.push(String(input));
		return Response.json(rows);
	};
	return urls;
}

const post = (t: { id: string; isAdmin: boolean }) =>
	route.POST(new Request("http://x/api/models", {
		method: "POST",
		headers: { "x-auth-request-user": t.id, "x-auth-request-groups": t.isAdmin ? "/learnharness,/learnharness-admin" : "/learnharness" },
	}));

test("only new ids on a bundled route are admitted, and only keyed providers are asked", async () => {
	const urls = stubFeed([
		row,
		{ ...row, id: bundled.id, name: "Renamed bundled" },
		{ ...row, id: "test-other-route", baseUrl: "https://route.invalid/v1" },
	]);
	assert.equal(await catalog.refreshModelCatalog(), "updated");
	assert.deepEqual(urls, ["https://pi.dev/api/models/providers/openai?types=chat"]);
	assert.equal(piModels().getModel("openai", row.id)?.name, row.name);
	assert.equal(piModels().getModel("openai", bundled.id)?.name, bundled.name);
	assert.equal(piModels().getModel("openai", "test-other-route"), undefined);
	const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"));
	assert.deepEqual(Object.keys(saved.providers), ["openai"]);
	assert.deepEqual(saved.providers.openai.map((m: { id: string }) => m.id), [row.id]);
});

test("an invalid eligible row fails the refresh and publishes nothing", async () => {
	const before = fs.readFileSync(snapshotFile, "utf-8");
	stubFeed([{ ...row, id: "test-bad-model", cost: { ...row.cost, input: -1 } }]);
	await assert.rejects(catalog.refreshModelCatalog());
	stubFeed([{ ...row, id: "test-bad-flag", compat: { notAWireFlag: true } }]);
	await assert.rejects(catalog.refreshModelCatalog());
	assert.equal(fs.readFileSync(snapshotFile, "utf-8"), before);
	assert.equal(piModels().getModel("openai", "test-bad-model"), undefined);
});

test("POST /api/models is admin only; the allow-list still gates an imported model", async () => {
	const urls = stubFeed([row]);
	assert.equal((await post(USER)).status, 403);
	assert.equal(urls.length, 0);
	const res = await post(ADMIN);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).outcome, "unchanged");
	const ids = (t: typeof ADMIN) => runAsTenant(t, () => modelCatalog().models.map((m) => m.id));
	assert.ok(ids(ADMIN).includes(row.id));
	assert.ok(!ids(USER).includes(row.id));
});

test("startup overlays the saved snapshot without a fetch", () => {
	globalThis.fetch = async () => { throw new Error("startup must not fetch"); };
	const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"));
	saved.providers.openai.push({ ...row, id: "test-restored-model" });
	fs.writeFileSync(snapshotFile, JSON.stringify(saved));
	catalog.loadModelCatalogSnapshot();
	assert.ok(piModels().getModel("openai", "test-restored-model"));
	assert.ok(piModels().getModel("openai", row.id));
});

test("the daily refresh respects the switch", async () => {
	const urls = stubFeed([row]);
	policy.setModelCatalogAutoRefresh(false);
	assert.equal(await catalog.runScheduledModelRefresh(), "off");
	assert.equal(urls.length, 0);
	policy.setModelCatalogAutoRefresh(true);
	assert.equal(await catalog.runScheduledModelRefresh(), "unchanged");
	assert.equal(urls.length, 1);
});
