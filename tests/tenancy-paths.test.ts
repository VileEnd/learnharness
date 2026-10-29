import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolated multi-user data dir BEFORE any config-loading import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tenancy-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
delete process.env.LH_LIBRARY_DIR;

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { PATHS } = await import("../config.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { pushStore } = await import("../src/store/push.ts");

const A = { id: "a", name: "A", isAdmin: false };
const B = { id: "b", name: "B", isAdmin: false };

test("settings and chats are per tenant", () => {
	runAsTenant(A, () => settingsStore.writeSettings({ version: 1, general: {} } as never));
	assert.ok(fs.existsSync(path.join(dir, "users", "a", "settings.json")));
	assert.equal(runAsTenant(B, () => settingsStore.readSettings()), null);
	const id = runAsTenant(A, () => chatStore.createChat("hello")).id;
	assert.ok(runAsTenant(A, () => chatStore.getChat(id)));
	assert.equal(runAsTenant(B, () => chatStore.getChat(id)), null);
});

test("graph ledgers are per tenant", () => {
	runAsTenant(A, () =>
		graphStore.appendNode({ id: "n_1", name: "n", statement: "s", aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [] }),
	);
	assert.equal(runAsTenant(A, () => graphStore.readNodes()).length, 1);
	assert.deepEqual(runAsTenant(B, () => graphStore.readNodes()), []);
});

test("push subscriptions are per tenant, VAPID is shared", () => {
	runAsTenant(A, () => pushStore.writeVapid({ publicKey: "pub", privateKey: "priv" }));
	assert.ok(fs.existsSync(path.join(dir, "global", "push", "vapid.json")));
	assert.deepEqual(runAsTenant(B, () => pushStore.readVapid()), { publicKey: "pub", privateKey: "priv" });
	runAsTenant(A, () => pushStore.saveSubscription({ endpoint: "https://e/1", keys: { p256dh: "p", auth: "a" }, createdAt: "2026-01-01T00:00:00Z", label: "t" }));
	assert.ok(fs.existsSync(path.join(dir, "users", "a", "push", "subscriptions.json")));
	assert.deepEqual(runAsTenant(B, () => pushStore.listSubscriptions()), []);
});

test("multi-user path access outside a tenant throws", () => {
	assert.throws(() => PATHS.chats, /NoTenantError|no tenant/i);
});

test("single-user mode keeps the legacy layout", () => {
	delete process.env.LH_MULTI_USER;
	try {
		assert.equal(PATHS.chats, path.join(dir, "chats"));
	} finally {
		process.env.LH_MULTI_USER = "1";
	}
});
