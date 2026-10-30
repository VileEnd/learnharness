/**
 * The custom endpoint in the engine, priced and gated (upstream port 6,
 * Task 2): the global record syncs a `custom` provider into piModels(); the
 * model gate runs first, then per-call revalidation, the image clone and
 * per-request thinking; free calls log a real $0, paid calls price from the
 * admin's rates, and a paid model without rates never reaches a capped
 * restricted user. Ids with a colon (Ollama `qwen3:8b`) round-trip.
 * Isolated LH_DATA_DIR / LH_AUTH_FILE in multi-user mode: dynamic imports.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-engine-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;
// A real-looking env key must never be used for the custom endpoint.
process.env.CUSTOM_OPENAI_API_KEY = "env-key-must-not-be-sent";
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	delete process.env.CUSTOM_OPENAI_API_KEY;
	fs.rmSync(dir, { recursive: true, force: true });
});

const h = await import("./helpers/custom-provider.ts");
const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { stores } = await import("../src/server/stores.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { setRequestSink } = await import("../src/agent/request-log.ts");
const policy = await import("../src/server/policy.ts");
const { spentThisMonth } = await import("../src/server/model-gate.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { catalogContextLimits, modelCatalog } = await import("../src/server/model-catalog.ts");
const { ModelNotAllowedError } = await import("../src/core/settings.ts");
const { allowedSet } = await import("../src/core/contracts/admin.ts");
const { lineCost } = await import("../src/core/usage.ts");
const { parseCustomModelSettings, resolveCustomModel } = await import("../src/core/contracts/custom-provider.ts");
const { prettyModel, splitQualified } = await import("../components/usage-format.ts");
const sectionRoute = await import("../app/api/settings/[section]/route.ts");
const modelsRoute = await import("../app/api/models/route.ts");
type RequestLogLine = import("../src/core/contracts/usage.ts").RequestLogLine;

const OLLAMA = "qwen3:8b";
const ADMIN = { id: "admin-a", name: "a", isAdmin: true };
const CAPPED = { id: "user-capped", name: "c", isAdmin: false };
const UNCAPPED = { id: "user-uncapped", name: "u", isAdmin: false };
const allowCustom = (cap: number | null) => ({ slots: {}, allowedModels: [`custom:${OLLAMA}`, "custom:paid-norates", "custom:paid-rated"], monthlyCapUsd: cap });

const routeHeaders = (t: { id: string; isAdmin: boolean }) => ({
	"x-auth-request-user": t.id,
	"x-auth-request-groups": t.isAdmin ? "/learnharness,/learnharness-admin" : "/learnharness",
	"content-type": "application/json",
});

let requests: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
let lines: RequestLogLine[] = [];

function answer(usage = { prompt_tokens: 10, completion_tokens: 5 }) {
	const chunk = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
	return new Response(
		chunk({ id: "fake", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }) +
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }) +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
}

const context = (messages: Message[] = [{ role: "user", content: "synthetic", timestamp: 0 }]) => normalizeContext({ messages });
const run = (engine: ReturnType<typeof piEngineForSpec>) => engine.streamFn(engine.model, context(), {}).result();
/** Wait for the request log's async observer to settle the line. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** free endpoint: an Ollama-style id, plus a paid pair used by the pricing cases. */
function seedFree(extra: Parameters<typeof h.seed>[0] = {}) {
	return h.seed({ pricing: "free", snapshot: [{ id: OLLAMA, context: 16384 }], ...extra });
}
function seedPaid() {
	return h.seed(
		{
			pricing: "paid",
			snapshot: [{ id: "paid-norates" }, { id: "paid-rated", image: true }],
			models: { "paid-rated": { inputUsdPerMTok: 2, outputUsdPerMTok: 8 } },
		},
		"sk-paid-endpoint",
	);
}

policy.setUserPolicy(CAPPED.id, allowCustom(5));
policy.setUserPolicy(UNCAPPED.id, allowCustom(null));

beforeEach(() => {
	requests = [];
	lines = [];
	fs.writeFileSync(path.join(dir, "auth.json"), "{}");
	fs.rmSync(path.join(dir, "global", "custom-provider.json"), { force: true });
	setRequestSink((line) => {
		lines.push(line);
		stores.requestLog.append(line);
	});
	globalThis.fetch = async (url, init) => {
		requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
		return answer();
	};
});

test("a custom model streams through the gate with faux fetch (Ollama id, image clone, keyless)", async () => {
	seedFree();
	await runAsTenant(CAPPED, async () => {
		const engine = piEngineForSpec({ provider: "custom", id: OLLAMA }, { purpose: "teacher" });
		assert.equal(engine.model.id, OLLAMA, "the gate passed the allowed key unchanged");
		assert.deepEqual(engine.model.input, ["text", "image"], "the engine model permits image attempts");
		assert.equal((await run(engine)).stopReason, "stop");
	});
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.url, `${h.BASE}/chat/completions`);
	assert.equal(requests[0]!.body.model, OLLAMA);
	assert.notEqual(requests[0]!.auth, "Bearer env-key-must-not-be-sent");
	assert.deepEqual(piModels().getModel("custom", OLLAMA)!.input, ["text"], "the registered capability is never promoted");
});

test("key mode sends only the bound file key, never the environment's", async () => {
	h.seed({ pricing: "free", snapshot: [{ id: OLLAMA }] }, "sk-file-bound");
	await runAsTenant(ADMIN, () => run(piEngineForSpec({ provider: "custom", id: OLLAMA })));
	assert.equal(requests[0]!.auth, "Bearer sk-file-bound");
});

test("free mode logs providerCostUsd: 0 and the cap counts $0", async () => {
	seedFree();
	await runAsTenant(CAPPED, async () => {
		stores.requestLog.markBackfilled();
		await run(piEngineForSpec({ provider: "custom", id: OLLAMA }, { purpose: "teacher" }));
		await settle();
		const line = lines.at(-1)!;
		assert.equal(line.provider, "custom");
		assert.equal(line.model, OLLAMA);
		assert.equal(line.outcome, "ok");
		assert.equal(line.providerCostUsd, 0);
		assert.deepEqual(spentThisMonth(), { usd: 0, unpriced: 0 });
	});
	assert.equal(callCost({ inputTokens: 1000, outputTokens: 1000 }, `custom:${OLLAMA}`), 0);
});

test("paid mode with rates prices the call; without rates it is unpriced, never $0", async () => {
	seedPaid();
	// 1M input at $2 + 0.5M output at $8 + 0.25M cached at the input rate.
	assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 250_000 }, "custom:paid-rated"), 2 + 4 + 0.5);
	assert.equal(callCost({ inputTokens: 1000, outputTokens: 1000 }, "custom:paid-norates"), null);
	assert.equal(callCost({ inputTokens: 1000, outputTokens: 1000 }, "custom:not-in-snapshot"), null);
	await runAsTenant(UNCAPPED, async () => {
		await run(piEngineForSpec({ provider: "custom", id: "paid-rated" }));
		await settle();
	});
	const line = lines.at(-1)!;
	assert.equal(line.providerCostUsd, undefined, "paid calls are priced at read time, not stamped");
	assert.ok(Math.abs(lineCost(line, callCost)! - (10 * 2 + 5 * 8) / 1_000_000) < 1e-12);
});

test("a capped user never gets a paid model without rates: 403, not in /api/models, refused by the editor", async () => {
	seedPaid();
	runAsTenant(CAPPED, () => {
		assert.throws(() => piEngineForSpec({ provider: "custom", id: "paid-norates" }, { purpose: "teacher" }), ModelNotAllowedError);
		assert.equal(piEngineForSpec({ provider: "custom", id: "paid-rated" }, { purpose: "teacher" }).model.id, "paid-rated");
	});
	const put = await sectionRoute.PUT(
		new Request("http://x/api/settings/models", { method: "PUT", headers: routeHeaders(CAPPED), body: JSON.stringify({ strong: { model: { provider: "custom", id: "paid-norates" } } }) }),
		{ params: Promise.resolve({ section: "models" }) },
	);
	assert.equal(put.status, 403);
	assert.equal(((await put.json()) as { code: string }).code, "model_not_allowed");
	const keys = async (t: { id: string; isAdmin: boolean }) => {
		const res = await modelsRoute.GET(new Request("http://x/api/models", { headers: routeHeaders(t) }));
		return ((await res.json()) as { models: { provider: string; id: string }[] }).models.map((m) => `${m.provider}:${m.id}`);
	};
	assert.deepEqual((await keys(CAPPED)).filter((k) => k.startsWith("custom:")), ["custom:paid-rated"]);
	// Uncapped users and admins may use it.
	assert.ok((await keys(UNCAPPED)).includes("custom:paid-norates"));
	assert.ok((await keys(ADMIN)).includes("custom:paid-norates"));
	runAsTenant(UNCAPPED, () => assert.equal(piEngineForSpec({ provider: "custom", id: "paid-norates" }).model.id, "paid-norates"));
	// The Users editor: a capped policy naming it is refused, an uncapped one is accepted.
	const models = runAsTenant(ADMIN, () => modelCatalog().models);
	const capped = policy.validatePolicy({ slots: {}, allowedModels: ["custom:paid-norates"], monthlyCapUsd: 5 }, models);
	assert.equal(capped.ok, false);
	const slot = policy.validatePolicy({ slots: { strong: { provider: "custom", id: "paid-norates" } }, allowedModels: [], monthlyCapUsd: 0 }, models);
	assert.equal(slot.ok, false);
	assert.equal(policy.validatePolicy({ slots: {}, allowedModels: ["custom:paid-norates"], monthlyCapUsd: null }, models).ok, true);
	assert.equal(policy.validatePolicy({ slots: {}, allowedModels: ["custom:paid-rated"], monthlyCapUsd: 5 }, models).ok, true);
});

test("the catalog lists custom models: image-capable first, honest costs, a provider row, context limits", () => {
	seedPaid();
	const catalog = runAsTenant(ADMIN, () => modelCatalog());
	const custom = catalog.models.filter((m) => m.provider === "custom");
	assert.deepEqual(custom.map((m) => m.id), ["paid-rated", "paid-norates"]);
	assert.deepEqual(custom[0]!.input, ["text", "image"]);
	assert.deepEqual(custom[0]!.cost, { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
	assert.equal(custom[1]!.cost, null, "paid without rates is unpriced, never a fake $0");
	assert.deepEqual(catalog.providers.find((p) => p.id === "custom"), { id: "custom", envVar: "", keyPresent: true });
	assert.equal(runAsTenant(ADMIN, () => catalogContextLimits()).get("custom:paid-rated"), 8192);
	seedFree();
	const free = runAsTenant(ADMIN, () => modelCatalog()).models.find((m) => m.provider === "custom")!;
	assert.deepEqual(free.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "free is the sanctioned real zero");
	fs.rmSync(path.join(dir, "global", "custom-provider.json"));
	const gone = runAsTenant(ADMIN, () => modelCatalog());
	assert.equal(gone.models.some((m) => m.provider === "custom"), false);
	assert.equal(gone.providers.some((p) => p.id === "custom"), false);
});

test("custom:qwen3:8b round-trips through the policy, the request log and prettyModel", async () => {
	seedFree();
	const key = `custom:${OLLAMA}`;
	const models = runAsTenant(ADMIN, () => modelCatalog().models);
	const v = policy.validatePolicy({ slots: { strong: { provider: "custom", id: OLLAMA } }, allowedModels: [key], monthlyCapUsd: 5 }, models);
	assert.ok(v.ok);
	assert.deepEqual(v.policy.slots.strong, { provider: "custom", id: OLLAMA });
	assert.ok(allowedSet(v.policy).has(key));
	await runAsTenant(CAPPED, async () => {
		await run(piEngineForSpec({ provider: "custom", id: OLLAMA }, { purpose: "teacher" }));
		await settle();
	});
	const line = lines.at(-1)!;
	assert.deepEqual([line.provider, line.model], ["custom", OLLAMA]);
	assert.equal(lineCost({ ...line, providerCostUsd: undefined }, callCost), 0, "the read-time key splits on the first colon");
	assert.deepEqual(splitQualified(key), { provider: "custom", id: OLLAMA });
	assert.equal(prettyModel(key, true), `${OLLAMA} · custom`);
	assert.equal(prettyModel(OLLAMA), OLLAMA);
});

test("a model removed from the snapshot mid-session refuses cleanly, without a request", async () => {
	seedFree();
	await runAsTenant(ADMIN, async () => {
		const engine = piEngineForSpec({ provider: "custom", id: OLLAMA });
		assert.equal((await run(engine)).stopReason, "stop");
		seedFree({ snapshot: [{ id: "other" }] });
		const refused = await run(engine);
		assert.equal(refused.stopReason, "error");
		assert.match(refused.errorMessage ?? "", /unavailable/);
		fs.rmSync(path.join(dir, "global", "custom-provider.json"));
		assert.equal((await run(engine)).stopReason, "error", "a disconnected endpoint refuses too");
	});
	assert.equal(requests.length, 1);
	assert.ok(piModels().getProvider("openrouter"), "built-in routes survive custom removal");
});

test("a mid-session pricing change re-gates the next call for a capped user", async () => {
	h.seed({ pricing: "free", snapshot: [{ id: "paid-norates" }] });
	await runAsTenant(CAPPED, async () => {
		const engine = piEngineForSpec({ provider: "custom", id: "paid-norates" }, { purpose: "teacher" });
		assert.equal((await run(engine)).stopReason, "stop");
		h.seed({ pricing: "paid", snapshot: [{ id: "paid-norates" }] });
		const refused = await run(engine);
		assert.equal(refused.stopReason, "error");
	});
	assert.equal(requests.length, 1);
});

test("thinking re-resolves per request from the original preference", async () => {
	seedFree();
	await runAsTenant(ADMIN, async () => {
		const engine = piEngineForSpec({ provider: "custom", id: OLLAMA, thinkingLevel: "high" });
		assert.equal(engine.level, "off");
		await run(engine);
		seedFree({ models: { [OLLAMA]: { reasoning: true } } });
		await run(engine);
		const unset = piEngineForSpec({ provider: "custom", id: OLLAMA });
		await run(unset);
		seedFree();
		await run(engine);
	});
	assert.deepEqual(requests.map((r) => r.body.reasoning_effort), [undefined, "high", "medium", undefined]);
});

test("context and max output are clamped to sane bounds, from pins and from the endpoint", () => {
	const huge = resolveCustomModel({ id: "m", context: 2_000_000_000, maxOutput: 2_000_000_000 }, undefined);
	assert.equal(huge.contextWindow, 10_000_000);
	assert.equal(huge.maxOutput, 1_000_000);
	const pinned = resolveCustomModel({ id: "m" }, { context: 99_000_000, maxOutput: 5_000_000 });
	assert.deepEqual([pinned.contextWindow, pinned.maxOutput], [10_000_000, 1_000_000]);
	const parsed = parseCustomModelSettings({ m: { context: 99_000_000, maxOutput: 5_000_000 } });
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.models.m, { context: 10_000_000, maxOutput: 1_000_000 });
});

test("per-model settings are read only from own keys (no prototype lookups)", () => {
	h.seed({ pricing: "paid", snapshot: [{ id: "constructor" }, { id: "toString" }], models: {} });
	assert.equal(callCost({ inputTokens: 1, outputTokens: 1 }, "custom:constructor"), null);
	const resolved = runAsTenant(ADMIN, () => modelCatalog()).models.filter((m) => m.provider === "custom");
	assert.deepEqual(resolved.map((m) => [m.id, m.contextWindow, m.cost]), [["constructor", 8192, null], ["toString", 8192, null]]);
});
