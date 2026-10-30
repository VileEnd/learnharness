/**
 * The server-side runtime view Task 2's engine consumes (upstream
 * custom-provider-lifecycle, server half): customProviderConfig() is read
 * fresh from the global record on every call, applies the model ladder, and
 * pairs the key with the URL only while the binding matches. The engine
 * half (piEngineForSpec, image clone, thinking) lands with the engine port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-lifecycle-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;
delete process.env.CUSTOM_OPENAI_API_KEY;
after(() => {
	mock.restoreAll();
	delete process.env.CUSTOM_OPENAI_API_KEY;
	fs.rmSync(dir, { recursive: true, force: true });
});

const h = await import("./helpers/custom-provider.ts");
const { customProviderConfig, customProviderModels } = await import("../src/server/custom-provider.ts");
const { authStore } = await import("../src/store/auth.ts");
const { customProviderStore } = await import("../src/store/custom-provider.ts");

const authFile = path.join(dir, "auth.json");
const configFile = path.join(dir, "global", "custom-provider.json");

beforeEach(() => {
	mock.restoreAll();
	fs.writeFileSync(authFile, "{}");
	fs.rmSync(path.join(dir, "global"), { recursive: true, force: true });
});

test("absent config: not configured, never throws", () => {
	assert.equal(customProviderConfig(), null);
	assert.deepEqual(customProviderModels(), []);
});

test("keyless config resolves models through pin > endpoint > default, with rates only when both are set", () => {
	h.seed({
		pricing: "paid",
		snapshot: [{ id: "bare" }, { id: "meta", context: 65536, maxOutput: 2048, image: true, reasoning: true }, { id: "qwen3:8b", context: 32768 }],
		models: { meta: { context: 1, reasoning: false, inputUsdPerMTok: 0.25, outputUsdPerMTok: 1 }, "qwen3:8b": { maxOutput: 512 } },
	});
	const runtime = customProviderConfig()!;
	assert.equal(runtime.baseUrl, h.BASE);
	assert.equal(runtime.mode, "keyless");
	assert.equal(runtime.pricing, "paid");
	assert.equal(runtime.apiKey, undefined);
	assert.deepEqual(runtime.models, [
		{ id: "bare", image: false, reasoning: false, contextWindow: 8192, maxOutput: 4096 },
		{ id: "meta", image: true, reasoning: false, contextWindow: 1, maxOutput: 2048, rates: { inputUsdPerMTok: 0.25, outputUsdPerMTok: 1 } },
		{ id: "qwen3:8b", image: false, reasoning: false, contextWindow: 32768, maxOutput: 512 },
	]);
	assert.deepEqual(customProviderModels(), runtime.models);
});

test("a key rotated under the same binding is used on the next read", () => {
	h.seed({}, "first-key");
	assert.equal(customProviderConfig()?.apiKey, "first-key");
	authStore.writeCustomAuth(authStore.readCustomAuth().binding, "rotated-key");
	assert.equal(customProviderConfig()?.apiKey, "rotated-key");
});

test("a nonce, URL or mode mismatch closes the endpoint, with no environment fallback", () => {
	process.env.CUSTOM_OPENAI_API_KEY = "environment-secret";
	try {
		const config = h.seed({}, "bound-key");
		authStore.writeCustomAuth({ version: 1, id: "b".repeat(32), baseUrl: config.baseUrl, mode: "key" }, "bound-key");
		assert.equal(customProviderConfig(), null, "nonce mismatch");
		h.seed({}, "bound-key");
		customProviderStore.writeConfig({ ...customProviderStore.readConfig()!, baseUrl: "http://192.0.2.99/v1" });
		assert.equal(customProviderConfig(), null, "a hand-edited URL never receives the key");
		h.seed({}, "bound-key");
		customProviderStore.writeConfig({ ...customProviderStore.readConfig()!, mode: "keyless" });
		assert.equal(customProviderConfig(), null, "mode mismatch");
		const keyless = h.seed();
		authStore.writeCustomAuth(undefined, undefined);
		assert.ok(keyless);
		assert.equal(customProviderConfig(), null, "keyless still needs its binding");
	} finally {
		delete process.env.CUSTOM_OPENAI_API_KEY;
	}
});

test("key mode without a key is closed", () => {
	const config = h.seed({}, "k");
	authStore.writeCustomAuth({ version: 1, id: config.bindingId, baseUrl: config.baseUrl, mode: "key" }, undefined);
	assert.equal(customProviderConfig(), null);
});

test("a model removed from the snapshot disappears; the endpoint stays usable", () => {
	h.seed({ snapshot: [{ id: "m" }, { id: "other" }] });
	customProviderStore.writeConfig({ ...customProviderStore.readConfig()!, snapshot: [{ id: "other" }] });
	assert.deepEqual(customProviderConfig()?.models.map((m) => m.id), ["other"]);
});

test("disconnect removes config, key and binding", async () => {
	h.seed({ mode: "key" }, "k");
	assert.equal((await h.mutate("DELETE", undefined)).status, 200);
	assert.equal(customProviderConfig(), null);
	assert.equal(fs.existsSync(configFile), false);
	assert.deepEqual(authStore.readCustomAuth(), { binding: undefined, key: undefined });
	assert.equal((await h.mutate("DELETE", undefined)).status, 200, "disconnect is idempotent");
});

test("corrupt config or unreadable auth reads as not configured, never throws", () => {
	h.seed();
	fs.writeFileSync(configFile, "{");
	assert.equal(customProviderConfig(), null);
	h.seed();
	fs.writeFileSync(authFile, "[]");
	assert.equal(customProviderConfig(), null);
});

test("the models view never carries the key", () => {
	h.seed({}, "secret-key");
	assert.ok(!JSON.stringify(customProviderModels()).includes("secret-key"));
});
