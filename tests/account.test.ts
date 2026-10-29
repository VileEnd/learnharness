import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolated data dir BEFORE any config-loading import; the mode is toggled per test.
process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-account-"));
delete process.env.LH_MULTI_USER;

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { accountInfo } = await import("../src/server/tenant.ts");
const me = await import("../app/api/me/route.ts");

const JAN = { id: "d63e2530-6178-4d5c-b645-2dce5abd25e2", name: "jan", isAdmin: true };

test("single-user mode: no account (nothing to sign out of)", () => {
	assert.equal(accountInfo(), null);
});

test("multi-user: name, admin flag, and a sign-out that also ends the Keycloak session", () => {
	process.env.LH_MULTI_USER = "1";
	process.env.LH_HOST = "learnharness.example.com";
	process.env.LH_LOGOUT_URL = "https://auth.example.com/realms/learnharness/protocol/openid-connect/logout";
	try {
		const account = runAsTenant(JAN, () => accountInfo());
		assert.equal(account?.name, "jan");
		assert.equal(account?.isAdmin, true);
		const url = new URL(account!.signOutUrl, "https://learnharness.example.com");
		assert.equal(url.pathname, "/oauth2/sign_out");
		const rd = new URL(url.searchParams.get("rd")!);
		assert.equal(rd.origin + rd.pathname, process.env.LH_LOGOUT_URL);
		assert.equal(rd.searchParams.get("client_id"), "learnharness");
		assert.equal(rd.searchParams.get("post_logout_redirect_uri"), "https://learnharness.example.com/");
	} finally {
		delete process.env.LH_MULTI_USER;
	}
});

test("multi-user without LH_LOGOUT_URL: plain app sign-out", () => {
	process.env.LH_MULTI_USER = "1";
	delete process.env.LH_LOGOUT_URL;
	try {
		assert.equal(runAsTenant(JAN, () => accountInfo())?.signOutUrl, "/oauth2/sign_out");
	} finally {
		delete process.env.LH_MULTI_USER;
	}
});

test("GET /api/me returns the caller's account", async () => {
	process.env.LH_MULTI_USER = "1";
	try {
		const res = await me.GET(new Request("http://x/api/me", {
			headers: { "x-auth-request-user": JAN.id, "x-auth-request-preferred-username": "jan" },
		}));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { account: { name: string; isAdmin: boolean } };
		assert.equal(body.account.name, "jan");
		assert.equal(body.account.isAdmin, false);
	} finally {
		delete process.env.LH_MULTI_USER;
	}
});
