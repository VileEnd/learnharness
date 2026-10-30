/**
 * Half-committed and damaged state fails closed (upstream
 * custom-provider-restart, adapted). Upstream proves this across a real
 * process restart because its engine caches; the fork's server reads both
 * files cold on every call, so a fresh customProviderConfig() read IS the
 * restart view. Faults are injected on the synthetic scratch files only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-restart-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;
delete process.env.CUSTOM_OPENAI_API_KEY;
const realFetch = globalThis.fetch;
after(() => {
	mock.restoreAll();
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

const h = await import("./helpers/custom-provider.ts");
const { customProviderConfig } = await import("../src/server/custom-provider.ts");
const { CUSTOM_AUTH_BINDING } = await import("../src/core/custom-provider-auth.ts");

const authFile = path.join(dir, "auth.json");
const configFile = path.join(dir, "global", "custom-provider.json");
const NEW = "http://192.0.2.20:8000/v1";
const auth = () => JSON.parse(fs.readFileSync(authFile, "utf8"));

let requests: string[];
beforeEach(() => {
	mock.restoreAll();
	fs.writeFileSync(authFile, JSON.stringify({ OTHER_PROVIDER_KEY: "untouched", future: { preserve: true } }), { mode: 0o600 });
	fs.rmSync(path.join(dir, "global"), { recursive: true, force: true });
	h.seed({ mode: "key" }, "old-key");
	requests = [];
	globalThis.fetch = async (url) => {
		requests.push(String(url));
		return Response.json({ data: [{ id: "m" }] });
	};
});

/** Fail renames onto the config file and, with `double`, the rollback rename onto the auth file too. */
function faultConfigWrite(double: boolean): void {
	const rename = fs.renameSync;
	const rm = fs.rmSync;
	let authRenames = 0;
	mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
		if (args[1] === configFile) throw new Error("fixture config I/O failure");
		if (args[1] === authFile && double && ++authRenames > 1) throw new Error("fixture auth I/O failure");
		return rename(...args);
	});
	mock.method(fs, "rmSync", (...args: Parameters<typeof rm>) => {
		if (args[0] === configFile) throw new Error("fixture config I/O failure");
		return rm(...args);
	});
}

test("new auth + old config (double I/O failure) stays closed; unrelated auth entries survive", async () => {
	faultConfigWrite(true);
	assert.equal((await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: "new-key" })).status, 500);
	mock.restoreAll();
	assert.equal(customProviderConfig(), null);
	assert.equal(auth().OTHER_PROVIDER_KEY, "untouched");
	assert.deepEqual(auth().future, { preserve: true });
});

test("a failed config write with a working rollback keeps the old setup usable with the old key", async () => {
	faultConfigWrite(false);
	assert.equal((await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: "new-key" })).status, 500);
	mock.restoreAll();
	const runtime = customProviderConfig()!;
	assert.equal(runtime.baseUrl, h.BASE);
	assert.equal(runtime.apiKey, "old-key");
});

test("keyless and disconnect half commits stay closed", async () => {
	for (const [method, body] of [["POST", { baseUrl: NEW, mode: "keyless", pricing: "free" }], ["DELETE", undefined]] as const) {
		fs.writeFileSync(authFile, "{}");
		h.seed({ mode: "key" }, "old-key");
		faultConfigWrite(true);
		assert.equal((await h.mutate(method, body)).status, 500, method);
		mock.restoreAll();
		assert.equal(customProviderConfig(), null, method);
	}
});

test("malformed auth files are never rewritten or used", async () => {
	for (const raw of ['{"OTHER_PROVIDER_KEY":"do-not-erase",', "[]", JSON.stringify({ OTHER_PROVIDER_KEY: "do-not-erase", [CUSTOM_AUTH_BINDING]: "not-json" }), JSON.stringify({ CUSTOM_OPENAI_API_KEY: 7 })]) {
		fs.writeFileSync(authFile, raw);
		assert.equal(customProviderConfig(), null, raw);
		const res = await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: "new-key" });
		assert.equal(res.status, 500, raw);
		assert.equal(((await res.json()) as { error: string }).error, "auth_unavailable");
		assert.equal(fs.readFileSync(authFile, "utf8"), raw);
	}
	assert.equal(requests.length, 0);
});

test("an unreadable auth file refuses writes and closes the endpoint", async () => {
	const before = fs.readFileSync(authFile, "utf8");
	const read = fs.readFileSync;
	mock.method(fs, "readFileSync", ((...args: Parameters<typeof read>) => {
		if (args[0] === authFile) throw Object.assign(new Error("fixture unreadable auth"), { code: "EACCES" });
		return read(...args);
	}) as typeof read);
	assert.equal(customProviderConfig(), null);
	assert.equal((await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: "new-key" })).status, 500);
	mock.restoreAll();
	assert.equal(fs.readFileSync(authFile, "utf8"), before);
});

test("a missing auth file starts closed and initializes with an explicit new key", async () => {
	fs.unlinkSync(authFile);
	assert.equal(customProviderConfig(), null);
	assert.equal((await h.post({ baseUrl: NEW, mode: "key", pricing: "free", key: "fresh-key" })).status, 200);
	assert.equal(customProviderConfig()?.apiKey, "fresh-key");
	assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
});
