import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-policy-"));
process.env.LH_DATA_DIR = dataDir;
process.env.LH_MULTI_USER = "1";

const policy = await import("../src/server/policy.ts");
const { runAsTenant, NoTenantError } = await import("../src/core/tenant-context.ts");
const { AdminPolicyCorrupt } = await import("../src/core/contracts/admin.ts");
const { allowedSet, modelKey } = await import("../src/core/contracts/admin.ts");

const U1 = "11111111-1111-4111-8111-111111111111";
const MIMO = { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash", input: ["text"] };
const DEEP = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", input: ["text", "image"] };

test("defaults: first available Cheapest for strong/cheap, skipping absent", () => {
	const d = policy.builtInDefaults([DEEP]);
	assert.deepEqual(d.slots.strong, { provider: "openrouter", id: DEEP.id });
	assert.deepEqual(d.slots.cheap, d.slots.strong);
	assert.deepEqual(d.allowedModels, [modelKey(DEEP)]);
	assert.deepEqual(policy.builtInDefaults([MIMO, DEEP]).slots.strong?.id, MIMO.id);
});

test("defaults: vision is first Cheapest accepting images, else unset", () => {
	assert.equal(policy.builtInDefaults([MIMO, DEEP]).slots.vision?.id, DEEP.id);
	assert.equal(policy.builtInDefaults([MIMO]).slots.vision, undefined);
});

test("defaults: cap is 5", () => {
	assert.equal(policy.builtInDefaults([MIMO]).monthlyCapUsd, 5);
});

test("allowedSet unions slot models", () => {
	const s = allowedSet({ slots: { strong: { provider: "a", id: "b" } }, allowedModels: ["c:d"], monthlyCapUsd: null });
	assert.deepEqual([...s].sort(), ["a:b", "c:d"]);
});

test("policyFor falls back to defaults; user entry wins", () => {
	const mine = { slots: {}, allowedModels: [], monthlyCapUsd: 1 };
	assert.equal(policy.policyFor(U1).monthlyCapUsd, 5);
	policy.setUserPolicy(U1, mine);
	assert.deepEqual(policy.policyFor(U1), mine);
	policy.setUserPolicy(U1, null);
	assert.equal(policy.policyFor(U1).monthlyCapUsd, 5);
});

test("restrictedPolicy: null for admins and single-user, policy for non-admin", () => {
	policy.setUserPolicy(U1, { slots: {}, allowedModels: [], monthlyCapUsd: 2 });
	runAsTenant({ id: U1, name: "u", isAdmin: false }, () => {
		assert.equal(policy.restrictedPolicy()?.monthlyCapUsd, 2);
	});
	runAsTenant({ id: U1, name: "u", isAdmin: true }, () => assert.equal(policy.restrictedPolicy(), null));
	process.env.LH_MULTI_USER = "";
	try {
		assert.equal(policy.restrictedPolicy(), null);
	} finally {
		process.env.LH_MULTI_USER = "1";
	}
});

test("admin.json is 0600 and round-trips", () => {
	const mine = { slots: {}, allowedModels: ["x:y"], monthlyCapUsd: null };
	policy.setDefaults(mine);
	const f = path.join(dataDir, "global", "admin.json");
	assert.equal(fs.statSync(f).mode & 0o777, 0o600);
	assert.deepEqual(policy.currentPolicy().newUserDefaults, mine);
});

test("validatePolicy rejects unknown model and negative cap; dedupes", () => {
	const ok = { slots: {}, allowedModels: [modelKey(MIMO), modelKey(MIMO)], monthlyCapUsd: 3 };
	const good = policy.validatePolicy(ok, [MIMO]);
	assert.ok(good.ok && good.policy.allowedModels.length === 1);
	assert.equal(policy.validatePolicy({ ...ok, allowedModels: ["nope:nope"] }, [MIMO]).ok, false);
	assert.equal(policy.validatePolicy({ ...ok, monthlyCapUsd: -1 }, [MIMO]).ok, false);
	assert.equal(policy.validatePolicy({ ...ok, monthlyCapUsd: null }, [MIMO]).ok, true);
});

const file = () => path.join(dataDir, "global", "admin.json");

test("empty catalog defaults: empty slots and allowed, cap 5, no throw", () => {
	const d = policy.builtInDefaults([]);
	assert.deepEqual(d.slots, {});
	assert.deepEqual(d.allowedModels, []);
	assert.equal(d.monthlyCapUsd, 5);
});

test("restrictedPolicy throws with no tenant in multi-user mode", () => {
	assert.throws(() => policy.restrictedPolicy(), NoTenantError);
});

test("setUserPolicy on a fresh install does not freeze newUserDefaults", () => {
	fs.rmSync(file(), { force: true });
	policy.setUserPolicy(U1, { slots: {}, allowedModels: [], monthlyCapUsd: 1 });
	const onDisk = JSON.parse(fs.readFileSync(file(), "utf-8"));
	assert.equal("newUserDefaults" in onDisk, false);
	assert.equal(policy.builtInDefaults([MIMO]).allowedModels.length, 1);
	assert.equal(policy.builtInDefaults([MIMO, DEEP]).allowedModels.length, 2);
	fs.rmSync(file(), { force: true });
});

test("corrupt admin.json: writes refuse and leave the file untouched; enforcement fails closed", () => {
	for (const garbage of ["{not json", JSON.stringify({ version: 1, users: { [U1]: { slots: 3 } } }), JSON.stringify({ version: 1, users: {}, newUserDefaults: { slots: {} } })]) {
		fs.writeFileSync(file(), garbage);
		assert.throws(() => policy.setUserPolicy(U1, null), AdminPolicyCorrupt);
		assert.throws(() => policy.setDefaults({ slots: {}, allowedModels: [], monthlyCapUsd: 1 }), AdminPolicyCorrupt);
		assert.throws(() => policy.currentPolicy(), AdminPolicyCorrupt);
		assert.equal(fs.readFileSync(file(), "utf-8"), garbage);
		const origErr = console.error;
		console.error = () => {};
		try {
			runAsTenant({ id: U1, name: "u", isAdmin: false }, () => {
				assert.deepEqual(policy.restrictedPolicy(), { slots: {}, allowedModels: [], monthlyCapUsd: 0 });
			});
			runAsTenant({ id: U1, name: "u", isAdmin: true }, () => assert.equal(policy.restrictedPolicy(), null));
		} finally {
			console.error = origErr;
		}
	}
	fs.rmSync(file(), { force: true });
});
