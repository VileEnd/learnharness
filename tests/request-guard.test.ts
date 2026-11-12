import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolated multi-user data dir BEFORE any config-loading import.
process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-guard-"));
process.env.LH_MULTI_USER = "1";

const { withTenant } = await import("../src/server/tenant.ts");

const UUID = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const handler = withTenant(async () => Response.json({ ok: true }));
const call = (method: string, headers: Record<string, string> = {}) =>
	handler(new Request("http://app.example.com/api/x", { method, headers: { "x-auth-request-user": UUID, host: "app.example.com", ...headers } }));

test("a cross-site write is refused with 403, even when it carries a session", async () => {
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		const res = await call(method, { "sec-fetch-site": "cross-site", origin: "https://evil.example.com" });
		assert.equal(res.status, 403, method);
		assert.deepEqual(await res.json(), { error: "same_origin_required" });
	}
	assert.equal((await call("POST", { "sec-fetch-site": "same-site" })).status, 403);
});

test("without Sec-Fetch-Site, an Origin that differs from the Host is refused", async () => {
	assert.equal((await call("POST", { origin: "https://evil.example.com" })).status, 403);
	assert.equal((await call("POST", { origin: "null" })).status, 403);
});

test("same-origin browsers, address-bar navigations and non-browser clients pass", async () => {
	assert.equal((await call("POST", { "sec-fetch-site": "same-origin", origin: "https://app.example.com" })).status, 200);
	assert.equal((await call("POST", { "sec-fetch-site": "none" })).status, 200);
	assert.equal((await call("POST", { origin: "https://app.example.com" })).status, 200);
	assert.equal((await call("POST")).status, 200);
});

test("reads are never checked", async () => {
	for (const method of ["GET", "HEAD", "OPTIONS"]) {
		assert.equal((await call(method, { "sec-fetch-site": "cross-site", origin: "https://evil.example.com" })).status, 200, method);
	}
});

test("the check runs after identity: an unauthenticated cross-site write is still 401", async () => {
	const res = await handler(new Request("http://app.example.com/api/x", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
	assert.equal(res.status, 401);
});

test("forwarded headers are never trusted: a forged X-Forwarded-Host/Proto equal to the Origin is still refused", async () => {
	const forged = { "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https", forwarded: "host=evil.example.com;proto=https" };
	assert.equal((await call("POST", { ...forged, origin: "https://evil.example.com" })).status, 403);
	assert.equal((await call("POST", { ...forged, origin: "https://evil.example.com", "sec-fetch-site": "cross-site" })).status, 403);
});
