import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-admin-policy-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
process.env.KC_ADMIN_API_URL = "http://kc.test";
process.env.KC_ADMIN_API_SECRET = "s3cret";
process.env.OPENROUTER_API_KEY ??= "test-key-admin-policy";
delete process.env.LH_ADMIN_GROUP;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { currentTenant, runAsTenant } = await import("../src/core/tenant-context.ts");
const { stores } = await import("../src/server/stores.ts");
const policyRoute = await import("../app/api/admin/policy/route.ts");
const defaultsRoute = await import("../app/api/admin/policy/defaults/route.ts");
const userPolicyRoute = await import("../app/api/admin/users/[id]/policy/route.ts");
const usageRoute = await import("../app/api/admin/usage/route.ts");

const ADMIN = "admin-a";
const U1 = "user-1";
const U2 = "user-2";
const M = (id: string) => ({ provider: "openrouter", id });
const STRONG = M("xiaomi/mimo-v2.6-flash");
const POLICY = { slots: { strong: STRONG, cheap: STRONG }, allowedModels: [`openrouter:${STRONG.id}`], monthlyCapUsd: 7 };

let kcFails = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const p = new URL(String(input)).pathname;
	const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
	if (kcFails) return json({}, 500);
	if (p.endsWith("/token")) return json({ access_token: "tok", expires_in: 300 });
	if (p.endsWith("/groups")) return json([{ id: "g1", name: "learnharness-admin" }]);
	if (p.endsWith("/members")) return json([{ id: U2, username: "two", enabled: true }]);
	if (p.endsWith("/users")) return json([{ id: U1, username: "one", enabled: true }, { id: U2, username: "two", enabled: true }]);
	return json({}, 404);
}) as typeof fetch;
after(() => {
	globalThis.fetch = realFetch;
});

const req = (admin: boolean, body?: unknown) =>
	new Request("http://x/api/admin", {
		method: body === undefined ? "GET" : "PUT",
		headers: { "x-auth-request-user": ADMIN, "x-auth-request-groups": admin ? "/learnharness,/learnharness-admin" : "/learnharness", "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("non-admin gets 403 on every route", async () => {
	for (const res of [
		await policyRoute.GET(req(false)),
		await defaultsRoute.PUT(req(false, POLICY)),
		await userPolicyRoute.PUT(req(false, POLICY), params(U1)),
		await usageRoute.GET(req(false)),
	]) {
		assert.equal(res.status, 403);
		assert.deepEqual(await res.json(), { error: "admin_only" });
	}
});

test("defaults round-trip", async () => {
	assert.equal((await defaultsRoute.PUT(req(true, POLICY))).status, 204);
	const body = (await (await policyRoute.GET(req(true))).json()) as { defaults: unknown; users: unknown };
	assert.deepEqual(body.defaults, POLICY);
	assert.deepEqual(body.users, {});
});

test("user policy set, then reset to defaults", async () => {
	const other = { ...POLICY, monthlyCapUsd: null };
	assert.equal((await userPolicyRoute.PUT(req(true, other), params(U1))).status, 204);
	let body = (await (await policyRoute.GET(req(true))).json()) as { users: Record<string, unknown> };
	assert.deepEqual(body.users[U1], other);
	assert.equal((await userPolicyRoute.PUT(req(true, { useDefaults: true }), params(U1))).status, 204);
	body = (await (await policyRoute.GET(req(true))).json()) as { users: Record<string, unknown> };
	assert.deepEqual(body.users, {});
});

test("an invalid model gives 400 invalid_policy with detail", async () => {
	const bad = { ...POLICY, allowedModels: ["openrouter:no/such-model"] };
	for (const res of [await defaultsRoute.PUT(req(true, bad)), await userPolicyRoute.PUT(req(true, bad), params(U1))]) {
		assert.equal(res.status, 400);
		const b = (await res.json()) as { error: string; detail: string };
		assert.equal(b.error, "invalid_policy");
		assert.match(b.detail, /unknown model/);
	}
});

test("usage folds two tenants' logs separately", async () => {
	const line = (usd: number | undefined) => ({
		v: 1 as const, at: new Date().toISOString(), purpose: "teacher", category: "teaching" as const, provider: "openrouter", model: STRONG.id, outcome: "ok" as const,
		...(usd !== undefined && { providerCostUsd: usd }),
	});
	runAsTenant({ id: U1, name: "one", isAdmin: false }, () => {
		stores.requestLog.append(line(1.5));
		stores.requestLog.append(line(0.25));
	});
	runAsTenant({ id: U2, name: "two", isAdmin: false }, () => stores.requestLog.append(line(4)));
	const res = await usageRoute.GET(req(true));
	assert.equal(res.status, 200);
	const b = (await res.json()) as { month: string; users: { userId: string; spentUsd: number; unpricedCalls: number; capUsd: number | null; restricted: boolean }[] };
	assert.match(b.month, /^\d{4}-\d{2}$/);
	const by = Object.fromEntries(b.users.map((u) => [u.userId, u]));
	assert.equal(by[U1]!.spentUsd, 1.75);
	assert.equal(by[U2]!.spentUsd, 4);
	assert.equal(by[U1]!.capUsd, 7);
	assert.equal(by[U1]!.restricted, true);
	assert.equal(by[U2]!.restricted, false); // Keycloak admin
	assert.equal(by[U2]!.capUsd, null); // no cap applies to an unrestricted row
});

test("usage still answers when Keycloak fails: everyone restricted", async () => {
	kcFails = true;
	const res = await usageRoute.GET(req(true));
	kcFails = false;
	assert.equal(res.status, 200);
	const b = (await res.json()) as { users: { userId: string; restricted: boolean }[] };
	const by = Object.fromEntries(b.users.map((u) => [u.userId, u]));
	assert.ok(b.users.length >= 2);
	assert.equal(by[ADMIN]?.restricted ?? false, false); // the requester, if listed, is a known admin
	assert.equal(by[U1]!.restricted, true);
});

test("usage: the requester's own row is unrestricted when Keycloak is unknown", async () => {
	runAsTenant({ id: ADMIN, name: "a", isAdmin: true }, () => stores.requestLog.append({ v: 1, at: new Date().toISOString(), purpose: "teacher", category: "teaching", provider: "openrouter", model: STRONG.id, outcome: "ok", providerCostUsd: 1 }));
	kcFails = true;
	const res = await usageRoute.GET(req(true));
	kcFails = false;
	const b = (await res.json()) as { users: { userId: string; restricted: boolean; capUsd: number | null }[] };
	const self = b.users.find((u) => u.userId === ADMIN)!;
	assert.equal(self.restricted, false);
	assert.equal(self.capUsd, null);
});

test("PUT user policy rejects traversal and leading-dot ids", async () => {
	for (const id of ["../x", "..%2Fx", ".hidden", "a/b"]) {
		const res = await userPolicyRoute.PUT(req(true, POLICY), params(id));
		assert.equal(res.status, 400, id);
		assert.deepEqual(await res.json(), { error: "invalid_user" });
	}
});

test("one tenant's unreadable log leaves the others intact", async () => {
	const BAD = "user-bad";
	runAsTenant({ id: BAD, name: "bad", isAdmin: false }, () => stores.requestLog.append({ v: 1, at: new Date().toISOString(), purpose: "teacher", category: "teaching", provider: "openrouter", model: STRONG.id, outcome: "ok", providerCostUsd: 1 }));
	// The store swallows file errors, so make the fold itself throw for this tenant.
	const orig = stores.requestLog.readMonth.bind(stores.requestLog);
	const spy = mock.method(stores.requestLog, "readMonth", (month: string) => {
		if (currentTenant()?.id === BAD) throw new Error("boom");
		return orig(month);
	});
	const res = await usageRoute.GET(req(true));
	assert.equal(res.status, 200);
	const b = (await res.json()) as { users: { userId: string; spentUsd: number | null; unpricedCalls: number | null; error?: string }[] };
	const by = Object.fromEntries(b.users.map((u) => [u.userId, u]));
	assert.equal(by[BAD]!.error, "usage_unreadable");
	assert.equal(by[BAD]!.spentUsd, null);
	assert.equal(by[BAD]!.unpricedCalls, null);
	assert.equal(by[U1]!.spentUsd, 1.75);
	assert.equal(by[U1]!.error, undefined);
	spy.mock.restore();
	fs.rmSync(path.join(dir, "users", BAD), { recursive: true, force: true });
});

test("a corrupt admin.json maps to 500 admin_policy_corrupt", async () => {
	const file = path.join(dir, "global", "admin.json");
	const good = fs.readFileSync(file, "utf8");
	fs.writeFileSync(file, "{not json");
	try {
		for (const res of [await policyRoute.GET(req(true)), await defaultsRoute.PUT(req(true, POLICY)), await userPolicyRoute.PUT(req(true, POLICY), params(U1)), await usageRoute.GET(req(true))]) {
			assert.equal(res.status, 500);
			assert.deepEqual(await res.json(), { error: "admin_policy_corrupt" });
		}
	} finally {
		fs.writeFileSync(file, good);
	}
});
