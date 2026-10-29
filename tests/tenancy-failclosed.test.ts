import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolated multi-user data dir with a LEGACY layout, BEFORE any config-loading import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-failclosed-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
process.env.LH_AUTH_FILE = path.join(dir, "auth-test.json");
delete process.env.LH_ADMIN_GROUP;
fs.mkdirSync(path.join(dir, "chats"));
fs.writeFileSync(path.join(dir, "settings.json"), "{}");

const { LegacyLayoutError, globalDataRoot } = await import("../config.ts");
const settings = await import("../app/api/settings/route.ts");
const keyRoute = await import("../app/api/keys/[id]/route.ts");
const promptRoute = await import("../app/api/settings/prompts/[...segment]/route.ts");

const USER = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const req = (init: RequestInit & { groups?: string } = {}) =>
	new Request("http://x/api", {
		...init,
		headers: {
			"x-auth-request-user": USER,
			...(init.groups ? { "x-auth-request-groups": init.groups } : {}),
			"content-type": "application/json",
		},
	});

test("legacy layout: tenant routes answer 503 legacy_layout, globalDataRoot throws", async () => {
	const res = await settings.GET(req());
	assert.equal(res.status, 503);
	const body = (await res.json()) as { error: string; fix: string };
	assert.equal(body.error, "legacy_layout");
	assert.match(body.fix, /docker exec -u node learnharness-learnharness-1 node scripts\/migrate-to-tenants\.mjs/);
	assert.throws(() => globalDataRoot(), LegacyLayoutError);
	assert.equal(fs.existsSync(path.join(dir, "global")), false);
});

test("after the migration moved the legacy entries away the same request is 200", async () => {
	fs.mkdirSync(path.join(dir, "users", USER), { recursive: true });
	fs.renameSync(path.join(dir, "chats"), path.join(dir, "users", USER, "chats"));
	fs.renameSync(path.join(dir, "settings.json"), path.join(dir, "users", USER, "settings.json"));
	const res = await settings.GET(req());
	assert.equal(res.status, 200);
	assert.doesNotThrow(() => globalDataRoot());
});

const keyCtx = { params: Promise.resolve({ id: "OPENROUTER_API_KEY" }) };
const put = (groups?: string) => req({ method: "PUT", body: "not json", groups });

test("keys: non-admin write is 403 admin_only, admin passes the guard", async () => {
	const denied = await keyRoute.PUT(put("learnharness"), keyCtx);
	assert.equal(denied.status, 403);
	assert.deepEqual(await denied.json(), { error: "admin_only" });
	const del = await keyRoute.DELETE(req({ method: "DELETE" }), keyCtx);
	assert.equal(del.status, 403);
	const ok = await keyRoute.PUT(put("learnharness,learnharness-admin"), keyCtx);
	assert.equal(ok.status, 400); // past the guard, rejected for the bad body
});

test("prompt overrides: non-admin write is 403", async () => {
	const ctx = { params: Promise.resolve({ segment: ["x", "y.md"] }) };
	const res = await promptRoute.PUT(req({ method: "PUT", body: JSON.stringify({ text: "t" }) }), ctx);
	assert.equal(res.status, 403);
	const del = await promptRoute.DELETE(req({ method: "DELETE" }), ctx);
	assert.equal(del.status, 403);
	assert.equal(fs.existsSync(path.join(dir, "global", "prompts")), false);
});
