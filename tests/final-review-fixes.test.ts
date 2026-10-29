/**
 * Final-review fixes for per-user models and caps (multi-user design §10):
 * the per-turn spend clamp, no orphan chats over the cap, the corrupt-policy
 * refusal copy, prototype-key user ids and a raised cap taking effect at once.
 * Isolated LH_DATA_DIR in multi-user mode, so every app-module import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-final-review-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
process.env.OPENROUTER_API_KEY ??= "test-key-final-review";
delete process.env.LH_ADMIN_GROUP;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { stores } = await import("../src/server/stores.ts");
const { globalDataRoot } = await import("../config.ts");
const policy = await import("../src/server/policy.ts");
const { assertWithinCap } = await import("../src/server/model-gate.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { MonthlyCapReachedError, PolicyUnavailableError, policyRefusalCopy } = await import("../src/core/settings.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const chatRoute = await import("../app/api/chat/route.ts");

const M = (id: string) => ({ provider: "openrouter", id });
const STRONG = M("xiaomi/mimo-v2.6-flash");
const CHEAP = M("deepseek/deepseek-v4.1-flash");
const POLICY = { slots: { strong: STRONG, cheap: CHEAP, vision: CHEAP }, allowedModels: [], monthlyCapUsd: 5 };

const USER = { id: "user-a", name: "a", isAdmin: false };
const ADMIN = { id: "admin-b", name: "b", isAdmin: true };
const OVER = { id: "user-over", name: "o", isAdmin: false };
const WARM = { id: "user-warm", name: "w", isAdmin: false };
const SICK = { id: "user-sick", name: "s", isAdmin: false };
for (const t of [USER, OVER, WARM, SICK]) policy.setUserPolicy(t.id, POLICY);

const headers = (t: { id: string; isAdmin: boolean }) => ({
	"x-auth-request-user": t.id,
	"x-auth-request-groups": t.isAdmin ? "/learnharness,/learnharness-admin" : "/learnharness",
	"content-type": "application/json",
});

function spend(usd: number): void {
	stores.requestLog.append({ v: 1, at: new Date().toISOString(), purpose: "teacher", category: "teaching", provider: "openrouter", model: STRONG.id, outcome: "ok", providerCostUsd: usd });
}

/** Drive a turn until the agent is built; return the spend cap the build received. */
async function capSeenByTurn(tenant: typeof USER): Promise<number | undefined> {
	const chatId = runAsTenant(tenant, () => {
		const chat = stores.chatStore.createChat("Turn");
		stores.chatStore.saveSettings(chat.id, { model: STRONG });
		return chat.id;
	});
	let seen: number | undefined;
	const req = new Request("http://x/api/chat", {
		method: "POST",
		headers: headers(tenant),
		body: JSON.stringify({ chatId, input: { type: "text", text: "hello" } }),
	});
	await runAsTenant(tenant, () =>
		handleChatRequest(req, (opts) => {
			seen = opts.spendCapUsd;
			throw new Error("stop after build");
		}),
	).catch(() => {});
	return seen;
}

test("(1) a restricted user's turn spend cap is clamped to the remaining month", async () => {
	runAsTenant(USER, () => spend(4.9));
	const seen = await capSeenByTurn(USER);
	assert.ok(seen !== undefined && Math.abs(seen - 0.1) < 1e-9, `got ${seen}`);
});

test("(1) an admin gets the configured turn spend cap", async () => {
	runAsTenant(ADMIN, () => spend(4.9));
	const seen = await capSeenByTurn(ADMIN);
	assert.equal(seen, 0.5); // the default per-turn cap, untouched by the $4.90 spend
});

test("(2) over the cap, POST /api/chats answers 403 and creates no chat", async () => {
	runAsTenant(OVER, () => spend(5.1));
	const before = runAsTenant(OVER, () => stores.chatStore.listChats().length);
	const res = await chatsRoute.POST(new Request("http://x/api/chats", { method: "POST", headers: headers(OVER), body: JSON.stringify({ title: "hi" }) }));
	assert.equal(res.status, 403);
	const body = (await res.json()) as { code: string; capUsd: number };
	assert.equal(body.code, "monthly_cap_reached");
	assert.equal(body.capUsd, 5);
	assert.equal(runAsTenant(OVER, () => stores.chatStore.listChats().length), before);
	assert.match(policyRefusalCopy(body) ?? "", /spending limit \(\$5\)\. Ask your admin to raise it\./);
});

test("(2) an under-cap user still creates a chat", async () => {
	const res = await chatsRoute.POST(new Request("http://x/api/chats", { method: "POST", headers: headers(ADMIN), body: JSON.stringify({ title: "hi" }) }));
	assert.equal(res.status, 200);
});

test("(5) a user id named like an Object.prototype key gets the defaults and nothing throws", () => {
	for (const id of ["constructor", "toString", "__proto__"]) {
		const p = policy.policyFor(id);
		assert.equal(p.monthlyCapUsd, 5);
	}
});

test("(8) a raised cap takes effect with a warm spend cache and no new log line", () => {
	runAsTenant(WARM, () => {
		spend(5.5);
		assert.throws(() => assertWithinCap(), MonthlyCapReachedError); // warms the cache
		policy.setUserPolicy(WARM.id, { ...POLICY, monthlyCapUsd: 10 });
		assert.doesNotThrow(() => assertWithinCap());
	});
});

test("(4) a corrupt policy file refuses a restricted user with policy_unavailable, not a $0 limit", async () => {
	const file = path.join(globalDataRoot(), "admin.json");
	const good = fs.readFileSync(file, "utf-8");
	fs.writeFileSync(file, "{ not json");
	try {
		runAsTenant(SICK, () => assert.throws(() => assertWithinCap(), PolicyUnavailableError));
		const chatId = runAsTenant(SICK, () => stores.chatStore.createChat("Sick").id);
		const res = await chatRoute.POST(
			new Request("http://x/api/chat", { method: "POST", headers: headers(SICK), body: JSON.stringify({ chatId, input: { type: "text", text: "hello" } }) }),
		);
		assert.equal(res.status, 403);
		const body = (await res.json()) as { code: string; error: string };
		assert.equal(body.code, "policy_unavailable");
		assert.equal(policyRefusalCopy(body), "Your account settings can't be read right now. Ask your admin.");
		assert.doesNotMatch(body.error, /spending limit/);
	} finally {
		fs.writeFileSync(file, good);
	}
});
