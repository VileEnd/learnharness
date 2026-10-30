/**
 * Per-user models and monthly caps, enforced (multi-user design §10): the
 * engine gate, the cap refusal before a turn persists, write validation, the
 * catalog filter, the settings overlay and the chat refusal copy. Isolated
 * LH_DATA_DIR in multi-user mode, so every app-module import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-model-gate-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
process.env.OPENROUTER_API_KEY ??= "test-key-model-gate";
delete process.env.LH_ADMIN_GROUP;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { stores } = await import("../src/server/stores.ts");
const { piEngineForSpec, setModelGate } = await import("../src/agent/models.ts");
const policy = await import("../src/server/policy.ts");
const { assertWithinCap, modelGate, modelsConfigured } = await import("../src/server/model-gate.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { readSettingsRecord, writeSettingsRecord } = await import("../src/server/index.ts");
const { MonthlyCapReachedError, ModelNotAllowedError, monthlyCapReached, modelNotAllowed, slotsConfigured } = await import("../src/core/settings.ts");
const chatRoute = await import("../app/api/chat/route.ts");
const sectionRoute = await import("../app/api/settings/[section]/route.ts");
const modelsRoute = await import("../app/api/models/route.ts");
const chatSettingsRoute = await import("../app/api/chats/[id]/settings/route.ts");
const settingsRoute = await import("../app/api/settings/route.ts");
const { TurnErrorBanner } = await import("../components/chat.tsx");

const M = (id: string) => ({ provider: "openrouter", id });
const STRONG = M("xiaomi/mimo-v2.6-flash");
const CHEAP = M("deepseek/deepseek-v4.1-flash");
const EXTRA = M("z-ai/glm-5.3-flash");
const OTHER = M("openai/gpt-5");
const POLICY = {
	slots: { strong: STRONG, cheap: CHEAP, vision: CHEAP },
	allowedModels: [`openrouter:${EXTRA.id}`],
	monthlyCapUsd: 5,
};

const USER = { id: "user-a", name: "a", isAdmin: false };
const ADMIN = { id: "admin-b", name: "b", isAdmin: true };
const NO_SLOTS = { id: "user-c", name: "c", isAdmin: false };
const FRESH = { id: "user-d", name: "d", isAdmin: false };
const CAPPED = { id: "user-e", name: "e", isAdmin: false };
const NO_VISION = { id: "user-f", name: "f", isAdmin: false };
const RETRY_CAPPED = { id: "user-g", name: "g", isAdmin: false };
policy.setUserPolicy(USER.id, POLICY);
policy.setUserPolicy(CAPPED.id, POLICY);
policy.setUserPolicy(RETRY_CAPPED.id, POLICY);
policy.setUserPolicy(NO_VISION.id, { ...POLICY, slots: { strong: STRONG, cheap: CHEAP } });
policy.setUserPolicy(FRESH.id, POLICY);
policy.setUserPolicy(NO_SLOTS.id, { slots: {}, allowedModels: [`openrouter:${EXTRA.id}`], monthlyCapUsd: null });

const headers = (t: { id: string; isAdmin: boolean }) => ({
	"x-auth-request-user": t.id,
	"x-auth-request-groups": t.isAdmin ? "/learnharness,/learnharness-admin" : "/learnharness",
	"content-type": "application/json",
});

/** One priced request-log line for the ambient tenant. */
function spend(usd: number): void {
	stores.requestLog.append({ v: 1, at: new Date().toISOString(), purpose: "teacher", category: "teaching", provider: "openrouter", model: STRONG.id, outcome: "ok", providerCostUsd: usd });
}

test("(a) an allowed model under the cap builds unchanged", () => {
	runAsTenant(USER, () => {
		assert.equal(piEngineForSpec(EXTRA, { purpose: "teacher" }).model.id, EXTRA.id);
	});
});

test("(b) a disallowed model substitutes its tier's policy slot", () => {
	runAsTenant(USER, () => {
		assert.equal(piEngineForSpec(OTHER, { purpose: "teacher" }).model.id, STRONG.id);
		assert.equal(piEngineForSpec(OTHER, { purpose: "extractor" }).model.id, CHEAP.id);
	});
});

test("(c) a disallowed model with its tier slot unset is refused", () => {
	runAsTenant(NO_SLOTS, () => {
		assert.throws(() => piEngineForSpec(OTHER, { purpose: "teacher" }), ModelNotAllowedError);
	});
});

test("(f) the month spend is cached on the log file's size and mtime", () => {
	runAsTenant(USER, () => {
		stores.requestLog.markBackfilled();
		spend(0.01); // a new size: the next read folds the file again
		const spy = mock.method(stores.requestLog, "readMonth");
		try {
			assertWithinCap();
			assertWithinCap();
			assert.equal(spy.mock.callCount(), 1);
		} finally {
			spy.mock.restore();
		}
	});
});

test("(d) over the cap, POST /api/chat answers 403 before persisting", async () => {
	const chatId = runAsTenant(CAPPED, () => {
		spend(5.1);
		const chat = stores.chatStore.createChat("Capped");
		stores.chatStore.saveSettings(chat.id, { model: STRONG });
		return chat.id;
	});
	const before = runAsTenant(CAPPED, () => JSON.stringify(stores.chatStore.getChat(chatId)));
	const res = await chatRoute.POST(
		new Request("http://x/api/chat", { method: "POST", headers: headers(CAPPED), body: JSON.stringify({ chatId, input: { type: "text", text: "hello" } }) }),
	);
	assert.equal(res.status, 403);
	const body = (await res.json()) as { code: string; capUsd: number; spentUsd: number; error: string };
	assert.equal(body.code, "monthly_cap_reached");
	assert.equal(body.capUsd, 5);
	assert.ok(Math.abs(body.spentUsd - 5.1) < 1e-9);
	assert.equal(runAsTenant(CAPPED, () => JSON.stringify(stores.chatStore.getChat(chatId))), before);
	runAsTenant(CAPPED, () => assert.throws(() => assertWithinCap(), MonthlyCapReachedError));
});

test("(d2) a Retry at the cap gets the same 403 cap envelope and leaves the chat file unchanged", async () => {
	const chatId = runAsTenant(RETRY_CAPPED, () => {
		spend(5.1);
		const chat = stores.chatStore.createChat("Capped retry");
		stores.chatStore.saveSettings(chat.id, { model: STRONG });
		const failed = { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }), id: "failed" };
		stores.chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 }, failed]);
		return chat.id;
	});
	const before = runAsTenant(RETRY_CAPPED, () => JSON.stringify(stores.chatStore.getChat(chatId)));
	const res = await chatRoute.POST(
		new Request("http://x/api/chat", { method: "POST", headers: headers(RETRY_CAPPED), body: JSON.stringify({ chatId, input: { type: "retry" } }) }),
	);
	assert.equal(res.status, 403);
	assert.equal(((await res.json()) as { code: string }).code, "monthly_cap_reached");
	runAsTenant(RETRY_CAPPED, () => {
		assert.equal(JSON.stringify(stores.chatStore.getChat(chatId)), before);
		assert.equal(isTurnRunning(chatId), false);
	});
});

test("(e) an admin with the same spend is not blocked", async () => {
	const chatId = runAsTenant(ADMIN, () => {
		spend(5.1);
		assert.doesNotThrow(() => assertWithinCap());
		return stores.chatStore.createChat("Admin").id;
	});
	const res = await chatRoute.POST(
		new Request("http://x/api/chat", { method: "POST", headers: headers(ADMIN), body: JSON.stringify({ chatId, input: { type: "text", text: "hello" } }) }),
	);
	// Past the cap check: the next gate (no models configured) answers.
	assert.notEqual(res.status, 403);
	assert.equal(((await res.json()) as { code: string }).code, "models_not_configured");
});

test("(g) PUT models and the per-chat model reject a disallowed model with 403, accept an allowed one", async () => {
	const put = (strong: { provider: string; id: string }) =>
		sectionRoute.PUT(
			new Request("http://x/api/settings/models", { method: "PUT", headers: headers(USER), body: JSON.stringify({ strong: { model: strong } }) }),
			{ params: Promise.resolve({ section: "models" }) },
		);
	const refused = await put(OTHER);
	assert.equal(refused.status, 403);
	assert.equal(((await refused.json()) as { code: string }).code, "model_not_allowed");
	assert.equal((await put(EXTRA)).status, 200);
	const chatId = runAsTenant(USER, () => stores.chatStore.createChat("Pick").id);
	const pick = (model: { provider: string; id: string }) =>
		chatSettingsRoute.PUT(
			new Request(`http://x/api/chats/${chatId}/settings`, { method: "PUT", headers: headers(USER), body: JSON.stringify({ model }) }),
			{ params: Promise.resolve({ id: chatId }) },
		);
	assert.equal((await pick(OTHER)).status, 403);
	assert.equal((await pick(EXTRA)).status, 200);
});

test("(g2) an unchanged stored pin whose provider left the catalog does not block saving another slot; new disallowed picks still 403", async () => {
	const GONE = { provider: "gone-provider", id: "fixture-model" };
	const put = (body: unknown) =>
		sectionRoute.PUT(
			new Request("http://x/api/settings/models", { method: "PUT", headers: headers(USER), body: JSON.stringify(body) }),
			{ params: Promise.resolve({ section: "models" }) },
		);
	runAsTenant(USER, () => writeSettingsRecord({ version: 1, models: { strong: { model: GONE }, cheap: { model: CHEAP } } }));
	assert.equal((await put({ strong: { model: GONE }, cheap: { model: EXTRA } })).status, 200);
	assert.deepEqual(runAsTenant(USER, () => stores.settingsStore.readSettings())?.models?.strong?.model, GONE);
	// The bypass is catalog-existence only: a NEW disallowed pick is still refused by the allow-list.
	const refused = await put({ strong: { model: GONE }, cheap: { model: OTHER } });
	assert.equal(refused.status, 403);
	assert.equal(((await refused.json()) as { code: string }).code, "model_not_allowed");
	// Re-saving the unchanged gone slot with a thinking level preserves the preference (runtime clamps after reconnect).
	assert.equal((await put({ strong: { model: GONE, thinkingLevel: "high" }, cheap: { model: EXTRA } })).status, 200);
	assert.equal(runAsTenant(USER, () => stores.settingsStore.readSettings())?.models?.strong?.thinkingLevel, "high");
	// Swapping the gone slot to another unknown model is refused by the allow-list for a restricted user, not by the catalog check.
	assert.equal((await put({ strong: { model: { ...GONE, id: "other-fixture" } }, cheap: { model: EXTRA } })).status, 403);
});

test("(h) /api/models lists only allowed models for a restricted user", async () => {
	const keys = async (t: { id: string; isAdmin: boolean }) => {
		const res = await modelsRoute.GET(new Request("http://x/api/models", { headers: headers(t) }));
		return ((await res.json()) as { models: { provider: string; id: string }[] }).models.map((m) => `${m.provider}:${m.id}`);
	};
	assert.deepEqual((await keys(USER)).sort(), [STRONG, CHEAP, EXTRA].map((m) => `openrouter:${m.id}`).sort());
	assert.ok((await keys(ADMIN)).length > 3);
});

test("(i) a restricted user with no settings.json reads the policy slots", () => {
	runAsTenant(FRESH, () => {
		const record = readSettingsRecord();
		assert.ok(slotsConfigured(record?.models));
		assert.deepEqual(record?.models?.strong?.model, STRONG);
		assert.equal(stores.settingsStore.readSettings(), null); // nothing written to disk
	});
});

test("(j) the chat renders both refusals with their copy, not the generic banner", () => {
	const text = (message: string) => renderToStaticMarkup(createElement(TurnErrorBanner, { message })).replace(/&#x27;/g, "'");
	const cap = text(JSON.stringify(monthlyCapReached(5, 5.1)));
	assert.match(cap, /You've reached this month's spending limit \(\$5\)\. Ask your admin to raise it\./);
	assert.doesNotMatch(cap, /Something went wrong/);
	assert.match(text(JSON.stringify(modelNotAllowed("openrouter:openai/gpt-5"))), /That model isn't available for your account\./);
	assert.match(text("boom"), /Something went wrong: boom/);
});

test("(k) a restricted policy without a vision slot counts as configured", async () => {
	runAsTenant(NO_VISION, () => {
		assert.equal(slotsConfigured(readSettingsRecord()?.models), false); // the three-slot rule would fire setup
		assert.equal(modelsConfigured(), true);
	});
	const res = await settingsRoute.GET(new Request("http://x/api/settings", { headers: headers(NO_VISION) }));
	assert.equal(((await res.json()) as { configured: boolean }).configured, true);
});

test("(l) a restricted policy without a strong slot refuses a turn with 403 model_not_allowed", async () => {
	const chatId = runAsTenant(NO_SLOTS, () => stores.chatStore.createChat("No strong").id);
	const res = await chatRoute.POST(
		new Request("http://x/api/chat", { method: "POST", headers: headers(NO_SLOTS), body: JSON.stringify({ chatId, input: { type: "text", text: "hello" } }) }),
	);
	assert.equal(res.status, 403);
	assert.equal(((await res.json()) as { code: string }).code, "model_not_allowed");
});

test("(m) a turn refused at the engine build leaves the chat file unchanged and no turn claimed", async () => {
	const chatId = runAsTenant(ADMIN, () => {
		const chat = stores.chatStore.createChat("Late");
		stores.chatStore.saveSettings(chat.id, { model: STRONG });
		return chat.id;
	});
	const before = runAsTenant(ADMIN, () => JSON.stringify(stores.chatStore.getChat(chatId)));
	// Only the turn's own engine is refused (as if spend crossed the cap after the up-front checks).
	setModelGate((spec, opts) => {
		if (opts.purpose === "compaction") return spec;
		throw new MonthlyCapReachedError(5, 5.2);
	});
	try {
		const res = await chatRoute.POST(
			new Request("http://x/api/chat", { method: "POST", headers: headers(ADMIN), body: JSON.stringify({ chatId, input: { type: "text", text: "hello" } }) }),
		);
		assert.equal(res.status, 403);
	} finally {
		setModelGate(modelGate);
	}
	runAsTenant(ADMIN, () => {
		assert.equal(JSON.stringify(stores.chatStore.getChat(chatId)), before);
		assert.equal(isTurnRunning(chatId), false);
	});
});
