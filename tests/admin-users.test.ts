import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-admin-users-"));
process.env.LH_MULTI_USER = "1";
process.env.KC_ADMIN_API_URL = "http://kc.test";
process.env.KC_ADMIN_API_SECRET = "s3cret";
delete process.env.LH_ADMIN_GROUP;

const users = await import("../app/api/admin/users/route.ts");
const toggle = await import("../app/api/admin/users/[id]/admin/route.ts");

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GID = "99999999-9999-4999-8999-999999999999";

const kc = {
	users: new Map<string, Record<string, unknown>>(),
	admins: new Set<string>(),
	created: [] as Record<string, unknown>[],
};
kc.users.set(ADMIN, { id: ADMIN, username: "root", email: "r@x.io", enabled: true, createdTimestamp: 5 });
kc.users.set(OTHER, { id: OTHER, username: "bob", enabled: true, createdTimestamp: 9 });
kc.admins.add(ADMIN);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(String(input));
	const method = init?.method ?? "GET";
	const p = url.pathname;
	const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
	if (p === "/realms/learnharness/protocol/openid-connect/token") return json({ access_token: "tok", expires_in: 300 });
	const base = "/admin/realms/learnharness";
	if (p === `${base}/groups`) return json([{ id: GID, name: "learnharness-admin" }]);
	if (p === `${base}/groups/${GID}/members`) return json([...kc.admins].map((id) => kc.users.get(id)));
	if (p === `${base}/users` && method === "GET") return json([...kc.users.values()]);
	if (p === `${base}/users` && method === "POST") {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if ([...kc.users.values()].some((u) => u.username === body.username)) return json({ errorMessage: "exists" }, 409);
		kc.created.push(body);
		const id = "33333333-3333-4333-8333-333333333333";
		kc.users.set(id, { id, username: body.username, email: body.email, enabled: true, createdTimestamp: 1 });
		if ((body.groups as string[]).includes("/learnharness-admin")) kc.admins.add(id);
		return new Response(null, { status: 201, headers: { Location: `http://kc.test${base}/users/${id}` } });
	}
	const m = p.match(new RegExp(`^${base}/users/([^/]+)/groups/${GID}$`));
	if (m) {
		if (method === "PUT") kc.admins.add(m[1]!);
		else kc.admins.delete(m[1]!);
		return new Response(null, { status: 204 });
	}
	return json({}, 404);
}) as typeof fetch;
after(() => {
	globalThis.fetch = realFetch;
});

const req = (id: string | null, admin: boolean, init: RequestInit = {}) =>
	new Request("http://x/api/admin/users", {
		...init,
		headers: {
			...(id ? { "x-auth-request-user": id } : {}),
			"x-auth-request-groups": admin ? "/learnharness,/learnharness-admin" : "/learnharness",
			"content-type": "application/json",
		},
	});
const post = (admin: boolean, body: unknown) => users.POST(req(ADMIN, admin, { method: "POST", body: JSON.stringify(body) }));
const put = (target: string, body: unknown) =>
	toggle.PUT(req(ADMIN, true, { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id: target }) });

test("list: non-admin 403", async () => {
	const res = await users.GET(req(ADMIN, false));
	assert.equal(res.status, 403);
	assert.deepEqual(await res.json(), { error: "admin_only" });
});

test("list: admin sees users with isAdmin from group membership", async () => {
	const res = await users.GET(req(ADMIN, true));
	assert.equal(res.status, 200);
	const body = (await res.json()) as { users: { username: string; isAdmin: boolean; email: string | null }[] };
	assert.deepEqual(body.users.map((u) => [u.username, u.isAdmin]), [["bob", false], ["root", true]]);
	assert.equal(body.users[0]!.email, null);
});

test("create: 201 with a one-time 20-char password, temporary + UPDATE_PASSWORD + group", async () => {
	const res = await post(true, { username: "anna" });
	assert.equal(res.status, 201);
	const body = (await res.json()) as { user: { username: string; isAdmin: boolean }; temporaryPassword: string };
	assert.match(body.temporaryPassword, /^[A-Za-z0-9]{20}$/);
	assert.equal(body.user.username, "anna");
	assert.equal(body.user.isAdmin, false);
	const sent = kc.created[0] as { requiredActions: string[]; groups: string[]; credentials: { temporary: boolean; value: string }[] };
	assert.equal(sent.credentials[0]!.temporary, true);
	assert.equal(sent.credentials[0]!.value, body.temporaryPassword);
	assert.ok(sent.requiredActions.includes("UPDATE_PASSWORD"));
	assert.ok(sent.groups.includes("/learnharness"));
});

test("create: invalid username 400, duplicate 409, non-admin 403, bad email 400", async () => {
	let res = await post(true, { username: "Anna!" });
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: "invalid_username" });
	res = await post(true, { username: "bob" });
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { error: "username_taken" });
	assert.equal((await post(false, { username: "zed" })).status, 403);
	assert.equal((await post(true, { username: "zed", email: "nope" })).status, 400);
});

test("admin toggle: self-demotion 409, other user 204 and membership changes", async () => {
	let res = await put(ADMIN, { admin: false });
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { error: "self_demotion" });
	res = await put(OTHER, { admin: true });
	assert.equal(res.status, 204);
	assert.ok(kc.admins.has(OTHER));
	res = await put(OTHER, { admin: false });
	assert.equal(res.status, 204);
	assert.ok(!kc.admins.has(OTHER));
});

test("not configured: 503 user_admin_not_configured", async () => {
	delete process.env.KC_ADMIN_API_SECRET;
	try {
		const res = await users.GET(req(ADMIN, true));
		assert.equal(res.status, 503);
		assert.deepEqual(await res.json(), { error: "user_admin_not_configured" });
	} finally {
		process.env.KC_ADMIN_API_SECRET = "s3cret";
	}
});
