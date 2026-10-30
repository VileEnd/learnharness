/**
 * POST/PATCH/DELETE /api/custom-provider boundaries (upstream
 * custom-provider-boundaries, adapted): admin-only mutations, the key
 * binding (a key never follows a URL change), same-origin JSON, probe
 * limits, optimistic writes and full key redaction. Global store in a
 * scratch multi-user data dir; every upstream fetch is synthetic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-boundaries-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;
delete process.env.CUSTOM_OPENAI_API_KEY;
const realFetch = globalThis.fetch;
after(() => {
	mock.restoreAll();
	globalThis.fetch = realFetch;
	delete process.env.CUSTOM_OPENAI_API_KEY;
	fs.rmSync(dir, { recursive: true, force: true });
});

const h = await import("./helpers/custom-provider.ts");
const keys = await import("../src/server/keys.ts");
const { authStore } = await import("../src/store/auth.ts");
const { CUSTOM_PROVIDER } = await import("../src/core/auth-keys.ts");
const { CUSTOM_AUTH_BINDING } = await import("../src/core/custom-provider-auth.ts");
const inventory = await import("../app/api/keys/route.ts");
const ordinary = await import("../app/api/keys/[id]/route.ts");

const authFile = path.join(dir, "auth.json");
const configFile = path.join(dir, "global", "custom-provider.json");
const current = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
const customKey = () => authStore.readCustomAuth().key;
const NEW = "http://192.0.2.20:8000/v1";

let requests: { url: string; authorization: string | null }[];
beforeEach(() => {
	mock.restoreAll();
	fs.writeFileSync(authFile, "{}");
	fs.rmSync(path.join(dir, "global"), { recursive: true, force: true });
	h.seed();
	requests = [];
	globalThis.fetch = async (url, init) => {
		requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
		assert.equal(init?.redirect, "manual");
		assert.ok(init?.signal instanceof AbortSignal);
		return Response.json({ data: [{ id: "m" }] });
	};
});

test("a non-admin gets 403 admin_only on every mutation and sees only whether an endpoint exists", async () => {
	const before = fs.readFileSync(configFile, "utf8");
	for (const method of ["POST", "PATCH", "DELETE"] as const) {
		const res = await h.mutate(method, { baseUrl: NEW, mode: "keyless", pricing: "free", models: {} }, {}, false);
		assert.equal(res.status, 403);
		assert.deepEqual(await res.json(), { error: "admin_only" });
	}
	assert.equal(requests.length, 0);
	assert.equal(fs.readFileSync(configFile, "utf8"), before);
	assert.deepEqual(await (await h.get(false)).json(), { configured: true });
});

test("keyless probe never forwards a key, and a keyless edit drops the stored key", async () => {
	h.seed({}, "private-old");
	const res = await h.post({ baseUrl: NEW, mode: "keyless", pricing: "free", key: "do-not-use-this" });
	assert.equal(res.status, 200);
	assert.equal(requests[0]?.authorization, null);
	assert.equal(customKey(), undefined);
	assert.equal(authStore.readCustomAuth().binding?.baseUrl, NEW);
	assert.equal(current().mode, "keyless");
});

test("a new key is trimmed, probed exactly and stored; no response carries it", async () => {
	const KEY = "sk-distinctive-7f3a9c2e";
	const res = await h.post({ baseUrl: NEW, mode: "key", pricing: "paid", key: ` ${KEY} ` });
	assert.equal(res.status, 200);
	assert.ok(!(await res.text()).includes(KEY), "the POST response never carries the key");
	assert.equal(requests[0]?.authorization, `Bearer ${KEY}`);
	assert.equal(customKey(), KEY);
	const status = (await (await h.get()).json()) as { keyPresent: boolean; keyBound: boolean; usable: boolean };
	assert.equal(status.keyPresent, true);
	assert.equal(status.keyBound, true);
	assert.equal(status.usable, true);
	const body = await (await h.get()).text();
	assert.ok(!body.includes(KEY) && !body.includes("Bearer"), "the GET response never carries the key");
});

test("an edit to a different URL drops the key binding: no reuse without re-entering the key", async () => {
	h.seed({ mode: "key" }, "private-old");
	const keyed = { baseUrl: NEW, mode: "key", pricing: "free" };
	const refused = await h.post(keyed);
	assert.equal(refused.status, 400);
	assert.equal(((await refused.json()) as { error: string }).error, "key_required");
	assert.equal(requests.length, 0);
	assert.equal(customKey(), "private-old");
	assert.equal((await h.post({ ...keyed, reuseKey: true })).status, 400, "there is no reuse escape hatch");
	assert.equal((await h.post({ ...keyed, key: "fresh" })).status, 200);
	assert.equal(requests[0]?.authorization, "Bearer fresh");
	assert.equal(customKey(), "fresh");
	const binding = authStore.readCustomAuth().binding!;
	assert.equal(binding.baseUrl, NEW);
	assert.equal(binding.id, current().bindingId);
});

test("the same URL keeps its bound key", async () => {
	h.seed({ mode: "key" }, "retained");
	assert.equal((await h.post({ baseUrl: h.BASE, mode: "key", pricing: "free" })).status, 200);
	assert.equal(requests[0]?.authorization, "Bearer retained");
	assert.equal(customKey(), "retained");
});

test("an unbound key on the same URL is never used: the admin must re-enter it", async () => {
	h.seed({ mode: "key" }, "legacy-key");
	const map = JSON.parse(fs.readFileSync(authFile, "utf8"));
	delete map[CUSTOM_AUTH_BINDING];
	fs.writeFileSync(authFile, JSON.stringify(map));
	const status = (await (await h.get()).json()) as { keyPresent: boolean; keyBound: boolean; usable: boolean };
	assert.deepEqual([status.keyPresent, status.keyBound, status.usable], [true, false, false]);
	assert.equal((await h.post({ baseUrl: h.BASE, mode: "key", pricing: "free" })).status, 400);
	assert.equal(requests.length, 0);
});

test("GET /api/keys fully redacts the custom key at every length and hides the binding", async () => {
	const rows = async () => ((await (await inventory.GET(new Request("http://localhost/api/keys", { headers: h.headers() }))).json()) as { keys: { id: string; masked: string | null; present: boolean; source: string }[] }).keys;
	assert.equal(keys.saveKey("OPENAI_API_KEY", "ordinary-provider-key-abcd").ok, true);
	try {
		const plain = (await rows()).find((r) => r.id === "OPENAI_API_KEY")!;
		assert.equal(plain.masked, "…abcd (26 chars)");
		for (const value of ["1", "12", "123", "1234", "synthetic-custom-secret-longer-than-four"]) {
			assert.equal((await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: value })).status, 200);
			const all = await rows();
			// The custom key has its own editor: no row in the generic key list.
			assert.ok(!all.some((r) => r.id === CUSTOM_PROVIDER.envVar));
			assert.ok(!JSON.stringify(all).includes(value));
			assert.ok(!all.some((r) => r.id === CUSTOM_AUTH_BINDING));
			assert.deepEqual(all.find((r) => r.id === "OPENAI_API_KEY"), plain);
		}
		// The custom key is file-only: an environment variable never shows up as (or becomes) the custom key.
		process.env.CUSTOM_OPENAI_API_KEY = "765";
		const after = await rows();
		assert.ok(!after.some((r) => r.id === CUSTOM_PROVIDER.envVar));
		assert.ok(!JSON.stringify(after).includes("765"));
	} finally {
		delete process.env.CUSTOM_OPENAI_API_KEY;
		keys.deleteKey("OPENAI_API_KEY");
	}
});

test("generic key writes cannot touch the custom key or its binding", async () => {
	h.seed({ mode: "key" }, "bound");
	const before = fs.readFileSync(authFile, "utf8");
	for (const id of [CUSTOM_PROVIDER.envVar, CUSTOM_AUTH_BINDING]) {
		const context = { params: Promise.resolve({ id }) };
		assert.equal((await ordinary.PUT(new Request("http://localhost", { method: "PUT", headers: h.headers(), body: JSON.stringify({ value: "bypass" }) }), context)).status, 404);
		assert.equal((await ordinary.DELETE(new Request("http://localhost", { method: "DELETE", headers: h.headers() }), context)).status, 404);
		assert.equal(keys.saveKey(id, "bypass").ok, false);
		assert.throws(() => keys.deleteKey(id));
		assert.throws(() => authStore.setAuthVar(id, "bypass"));
		assert.throws(() => authStore.deleteAuthVar(id));
		assert.equal(keys.keyValue(id), undefined);
	}
	assert.equal(fs.readFileSync(authFile, "utf8"), before);
	keys.initAuthEnv();
	assert.equal(process.env[CUSTOM_AUTH_BINDING], undefined);
	assert.equal(process.env[CUSTOM_PROVIDER.envVar], undefined);
});

test("cross-origin, opaque or missing origins and non-JSON writes cannot probe or mutate", async () => {
	for (const origin of ["http://evil.example.com", "null", ""]) {
		const res = await h.post({ baseUrl: NEW, mode: "keyless", pricing: "free" }, { origin });
		assert.equal(res.status, 403);
		assert.equal(((await res.json()) as { error: string }).error, "same_origin_required");
	}
	assert.equal((await h.post({}, { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await h.post({}, { "content-type": "text/plain" })).status, 415);
	assert.equal(requests.length, 0);
});

test("the origin must match the addressed Host header, never a forwarded host", async () => {
	const extra = { host: "192.0.2.5:3317", origin: "https://192.0.2.5:3317" };
	assert.equal((await h.mutate("DELETE", undefined, extra)).status, 200);
	assert.equal((await h.mutate("DELETE", undefined, { "x-forwarded-host": "evil.example.com", origin: "http://evil.example.com" })).status, 403);
});

test("empty DELETE streams normalize; malformed or empty JSON elsewhere is a 400", async () => {
	const init = async (method: string, body: BodyInit | null): Promise<RequestInit & { duplex: "half" }> => ({ method, headers: h.headers(true, { "if-match": await h.etag() }), body, duplex: "half" });
	const empty = new ReadableStream({ start(c) { c.close(); } });
	assert.equal((await h.route.DELETE(new Request("http://localhost/api/custom-provider", await init("DELETE", empty)))).status, 200);
	assert.equal((await h.route.DELETE(new Request("http://localhost/api/custom-provider", await init("DELETE", "{")))).status, 400);
	assert.equal((await h.route.POST(new Request("http://localhost/api/custom-provider", await init("POST", "")))).status, 400);
});

test("forbidden URL components, modes and pricing are rejected before probing", async () => {
	for (const baseUrl of ["ftp://h.example.com", "https://user:pass@h.example.com/v1", "http://h.example.com/v1?q=secret", "http://h.example.com/v1#x", "http://h.example.com/v1?", "http://h.example.com/v1#"]) {
		const res = await h.post({ baseUrl, mode: "keyless", pricing: "free" });
		assert.equal(res.status, 400);
		assert.equal(((await res.json()) as { error: string }).error, "invalid_base_url");
	}
	assert.equal(((await (await h.post({ baseUrl: NEW, mode: "apiKey", pricing: "free" })).json()) as { error: string }).error, "invalid_mode");
	assert.equal(((await (await h.post({ baseUrl: NEW, mode: "keyless" })).json()) as { error: string }).error, "invalid_pricing");
	assert.equal(((await (await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: "a\nb" })).json()) as { error: string }).error, "invalid_key");
	// Outside printable ASCII (a header value the transport would mangle or reject).
	for (const key of ["sk-\u00e9t\u00e9", "sk-\u200bzero-width", "sk-\u{1F511}"]) {
		assert.equal(((await (await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key })).json()) as { error: string }).error, "invalid_key");
	}
	assert.equal(requests.length, 0);
});

test("redirects, auth failures, model and byte limits fail the probe even with typed ids", async () => {
	for (const answer of [
		() => new Response(null, { status: 302, headers: { location: "http://other.example.com" } }),
		() => new Response("private response", { status: 401 }),
		() => new Response("private response", { status: 403 }),
		() => Response.json({ data: Array(10001).fill({ id: "m" }) }),
		() => new Response("x".repeat(8 * 1024 * 1024 + 1)),
		() => new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }),
	]) {
		globalThis.fetch = async () => answer();
		const before = current();
		const res = await h.post({ baseUrl: NEW, mode: "keyless", pricing: "free", manualModels: "m" });
		assert.equal(res.status, 502);
		const text = await res.text();
		assert.equal((JSON.parse(text) as { error: string }).error, "probe_failed");
		assert.ok(!text.includes("private response"));
		assert.deepEqual(current(), before);
	}
});

test("write bodies are bounded at 64 KiB", async () => {
	assert.equal((await h.post({ baseUrl: "x".repeat(65536), mode: "keyless", pricing: "free" })).status, 413);
	assert.equal((await h.mutate("DELETE", { padding: "x".repeat(65536) })).status, 413);
	assert.equal(requests.length, 0);
});

test("a stale or missing If-Match refuses save, edit and disconnect without writing", async () => {
	const stale = await h.etag();
	h.seed({ baseUrl: "http://192.0.2.30/v1", snapshot: [{ id: "different" }] });
	const before = current();
	for (const method of ["POST", "PATCH", "DELETE"] as const) {
		for (const extra of [{ "if-match": stale }, { "if-match": "" }]) {
			const res = await h.mutate(method, { baseUrl: NEW, mode: "keyless", pricing: "free", models: {} }, extra);
			assert.equal(res.status, 409);
			assert.equal(((await res.json()) as { error: string }).error, "stale");
		}
	}
	assert.equal(requests.length, 0);
	assert.deepEqual(current(), before);
});

test("a config edit during the probe makes the save stale", async () => {
	globalThis.fetch = async () => {
		h.seed({ baseUrl: "http://192.0.2.31/v1", snapshot: [] });
		return Response.json({ data: [{ id: "m" }] });
	};
	assert.equal((await h.post({ baseUrl: NEW, mode: "keyless", pricing: "free" })).status, 409);
	assert.equal(current().baseUrl, "http://192.0.2.31/v1");
});

test("a key change during the probe makes the save stale", async () => {
	h.seed({ mode: "key" }, "before");
	globalThis.fetch = async () => {
		const auth = authStore.readCustomAuth();
		authStore.writeCustomAuth(auth.binding, "rotated");
		return Response.json({ data: [{ id: "m" }] });
	};
	assert.equal((await h.post({ baseUrl: h.BASE, mode: "key", pricing: "free" })).status, 409);
	assert.equal(customKey(), "rotated");
});

test("PATCH sets pins, rates and pricing without probing; bad values are 400s", async () => {
	const res = await h.mutate("PATCH", { pricing: "paid", models: { m: { context: 1, maxOutput: 512, reasoning: false, inputUsdPerMTok: 0.5, outputUsdPerMTok: 1.5 }, gone: { context: 9 } } });
	assert.equal(res.status, 200);
	assert.equal(requests.length, 0);
	assert.equal(current().pricing, "paid");
	assert.deepEqual(current().models, { m: { context: 1, maxOutput: 512, reasoning: false, inputUsdPerMTok: 0.5, outputUsdPerMTok: 1.5 } }, "ids outside the snapshot are pruned");
	const before = current();
	for (const body of [{ models: { m: { context: 1.5 } } }, { models: { m: { inputUsdPerMTok: -1, outputUsdPerMTok: 1 } } }, { models: { m: { inputUsdPerMTok: 1 } } }, { models: { m: { reasoning: "yes" } } }, { pricing: "cheap" }, {}]) {
		const bad = await h.mutate("PATCH", body);
		assert.equal(bad.status, 400, JSON.stringify(body));
	}
	assert.deepEqual(current(), before);
	assert.equal((await h.mutate("DELETE", undefined)).status, 200);
	const none = await h.mutate("PATCH", { pricing: "free" });
	assert.equal(none.status, 409);
	assert.equal(((await none.json()) as { error: string }).error, "not_configured");
});

test("a failed config write restores the previous key and binding and leaks no details", async () => {
	h.seed({ mode: "key" }, "old-key");
	const before = current();
	const authBefore = fs.readFileSync(authFile, "utf8");
	const rename = fs.renameSync;
	mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
		if (args[1] === configFile) throw new Error("private-io-details");
		return rename(...args);
	});
	const res = await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: "new-key" });
	assert.equal(res.status, 500);
	const text = await res.text();
	assert.equal((JSON.parse(text) as { error: string }).error, "save_failed");
	assert.ok(!text.includes("private-io-details"));
	assert.equal(customKey(), "old-key");
	assert.deepEqual(current(), before);
	assert.equal(fs.readFileSync(authFile, "utf8"), authBefore);
});

test("the config file is mode 0600, and a corrupt one reads as not configured and refuses every write", async () => {
	assert.equal((await h.post({ baseUrl: NEW, mode: "keyless", pricing: "free" })).status, 200);
	assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
	for (const raw of ["{\"version\":1,", "[]", JSON.stringify({ ...current(), mode: "apiKey" })]) {
		fs.writeFileSync(configFile, raw);
		const status = (await (await h.get()).json()) as { configured: boolean; corrupt?: boolean; usable: boolean };
		assert.deepEqual([status.configured, status.corrupt, status.usable], [false, true, false]);
		assert.deepEqual(await (await h.get(false)).json(), { configured: false });
		for (const method of ["POST", "PATCH", "DELETE"] as const) {
			const res = await h.mutate(method, { baseUrl: NEW, mode: "keyless", pricing: "free", models: {} });
			assert.equal(res.status, 500);
			assert.equal(((await res.json()) as { error: string }).error, "custom_provider_corrupt");
		}
		assert.equal(fs.readFileSync(configFile, "utf8"), raw);
	}
	assert.equal(requests.length, 1);
});
