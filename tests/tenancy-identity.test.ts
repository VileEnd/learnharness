import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolated multi-user data dir BEFORE any config-loading import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-identity-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
delete process.env.LH_LIBRARY_DIR;
delete process.env.LH_ADMIN_GROUP;

const { LOCAL_TENANT, runAsTenant } = await import("../src/core/tenant-context.ts");
const { resolveTenant, withTenant } = await import("../src/server/tenant.ts");

const UUID = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const hdr = (o: Record<string, string>) => new Headers(o);
const asUser = (id: string) => ({ "x-auth-request-user": id });

test("resolveTenant: missing or malformed user header is null", () => {
	assert.equal(resolveTenant(hdr({})), null);
	assert.equal(resolveTenant(hdr(asUser("a@b.com"))), null);
});

test("resolveTenant: a UUID is a tenant; name falls back preferred -> email -> id", () => {
	assert.deepEqual(resolveTenant(hdr(asUser(UUID))), { id: UUID, name: UUID, isAdmin: false });
	assert.equal(resolveTenant(hdr({ ...asUser(UUID), "x-auth-request-email": "e@x.io" }))?.name, "e@x.io");
	assert.equal(
		resolveTenant(hdr({ ...asUser(UUID), "x-auth-request-email": "e@x.io", "x-auth-request-preferred-username": "eve" }))?.name,
		"eve",
	);
});

test("resolveTenant: admin group, with or without a leading slash", () => {
	const g = (groups: string) => resolveTenant(hdr({ ...asUser(UUID), "x-auth-request-groups": groups }))?.isAdmin;
	assert.equal(g("learnharness,learnharness-admin"), true);
	assert.equal(g("/learnharness-admin"), true);
	assert.equal(g("learnharness"), false);
});

test("resolveTenant: an empty LH_ADMIN_GROUP never makes group-less users admins", () => {
	process.env.LH_ADMIN_GROUP = "";
	try {
		assert.equal(resolveTenant(hdr(asUser(UUID)))?.isAdmin, false);
		assert.equal(resolveTenant(hdr({ ...asUser(UUID), "x-auth-request-groups": "" }))?.isAdmin, false);
	} finally {
		delete process.env.LH_ADMIN_GROUP;
	}
});

test("resolveTenant: single-user mode is LOCAL_TENANT", () => {
	process.env.LH_MULTI_USER = "0";
	try {
		assert.equal(resolveTenant(hdr({})), LOCAL_TENANT);
	} finally {
		process.env.LH_MULTI_USER = "1";
	}
});

test("withTenant: 401 without the header; passes rest args through", async () => {
	const h = withTenant(async (_req: Request, extra: string) => Response.json({ extra }));
	const res = await h(new Request("http://x/"), "p");
	assert.equal(res.status, 401);
	assert.deepEqual(await res.json(), { error: "unauthenticated" });
	const ok = await h(new Request("http://x/", { headers: asUser("a") }), "p");
	assert.deepEqual(await ok.json(), { extra: "p" });
});

test("runAsTenant refuses an id that is not LOCAL or TENANT_ID_RE", () => {
	assert.throws(() => runAsTenant({ id: "../evil", name: "x", isAdmin: false }, () => 1));
	assert.equal(runAsTenant(LOCAL_TENANT, () => 1), 1);
});

test("settings written as user a are invisible to user b through the real routes", async () => {
	const put = (await import("../app/api/settings/[section]/route.ts")).PUT;
	const get = (await import("../app/api/settings/route.ts")).GET;
	const res = await put(
		new Request("http://x/api/settings/general", {
			method: "PUT",
			headers: { ...asUser("a"), "content-type": "application/json" },
			body: JSON.stringify({}),
		}),
		{ params: Promise.resolve({ section: "general" }) },
	);
	assert.equal(res.status, 200);
	const a = await (await get(new Request("http://x/api/settings", { headers: asUser("a") }))).json();
	assert.ok(a.settings);
	const b = await (await get(new Request("http://x/api/settings", { headers: asUser("b") }))).json();
	assert.deepEqual(b, { settings: null });
});

test("every app/api route except health wraps each exported HTTP method in withTenant(", () => {
	const apiDir = path.join(import.meta.dirname, "..", "app", "api");
	const files: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name === "route.ts") files.push(p);
		}
	};
	walk(apiDir);
	let checked = 0;
	for (const f of files) {
		if (f === path.join(apiDir, "health", "route.ts")) continue;
		const src = fs.readFileSync(f, "utf8");
		assert.ok(!/export (async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(src), `${f}: unwrapped function export`);
		const methods = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s*=\s*(.*)/g)];
		assert.ok(methods.length > 0, `${f}: no exported method`);
		for (const m of methods) assert.ok(m[2]!.startsWith("withTenant("), `${f}: ${m[1]} not wrapped`);
		checked++;
	}
	assert.equal(checked, 56);
});
