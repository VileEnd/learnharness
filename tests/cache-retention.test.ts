/**
 * Admin-global prompt-cache retention: the policy round-trip (absent = default,
 * survives the other policy writes), the admin route, and that ONLY the
 * conversation turn engine carries it to pi-ai (a stubbed fetch sees the Anthropic
 * cache_control ttl). Isolated LH_DATA_DIR in multi-user mode, so every
 * app-module import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cache-retention-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
process.env.OPENROUTER_API_KEY = "test-key-cache-retention";
delete process.env.PI_CACHE_RETENTION;
delete process.env.LH_ADMIN_GROUP;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { stores } = await import("../src/server/stores.ts");
const policy = await import("../src/server/policy.ts");
const { buildCompactionEngine, handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const route = await import("../app/api/admin/cache-retention/route.ts");

const ADMIN = { id: "admin-a", name: "a", isAdmin: true };
const USER = { id: "user-b", name: "b", isAdmin: false };
const MODEL = { provider: "openrouter", id: "anthropic/claude-haiku-4.5", thinkingLevel: "off" as const };
const file = path.join(dir, "global", "admin.json");

const headers = (t: { id: string; isAdmin: boolean }) => ({
	"x-auth-request-user": t.id,
	"x-auth-request-groups": t.isAdmin ? "/learnharness,/learnharness-admin" : "/learnharness",
	"content-type": "application/json",
});
const adminRequest = (t: { id: string; isAdmin: boolean }, body?: unknown) =>
	new Request("http://x/api/admin/cache-retention", {
		method: body === undefined ? "GET" : "PUT",
		headers: headers(t),
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

/** Which TTL does a one-call stream through this engine put on the wire? */
async function wireTtl(engine: PiEngine): Promise<string | undefined> {
	const originalFetch = globalThis.fetch;
	let body = "";
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).text();
		return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
	};
	try {
		await engine.streamFn(engine.model, normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] })).result();
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.match(body, /cache_control/, "the request carries Anthropic cache_control");
	return /"ttl":"([^"]+)"/.exec(body)?.[1];
}

test("absent reads as the default and survives every other policy write", () => {
	assert.equal(policy.conversationCacheRetention(), undefined);
	policy.setConversationCacheRetention("long");
	assert.equal(policy.conversationCacheRetention(), "long");
	policy.setClaudeCodeEnabled(true);
	policy.setDefaults({ slots: {}, allowedModels: [], monthlyCapUsd: 3 });
	policy.setUserPolicy("user-b", { slots: {}, allowedModels: [], monthlyCapUsd: 1 });
	assert.equal(policy.conversationCacheRetention(), "long");
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")).cacheRetention, { conversation: "long" });
	policy.setConversationCacheRetention("short");
	assert.equal(policy.conversationCacheRetention(), "short");
});

test("an unrecognised stored value or a corrupt file reads as the default, never an error", () => {
	const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
	fs.writeFileSync(file, JSON.stringify({ ...stored, cacheRetention: { conversation: "forever" } }));
	assert.equal(policy.conversationCacheRetention(), undefined);
	fs.writeFileSync(file, "{ not json");
	assert.equal(policy.conversationCacheRetention(), undefined);
	fs.writeFileSync(file, JSON.stringify({ ...stored, cacheRetention: undefined }));
});

test("the route: admin only, unset reads short, bad bodies are 400, a corrupt file is never overwritten", async () => {
	fs.rmSync(file, { force: true });
	assert.equal((await route.GET(adminRequest(USER))).status, 403);
	assert.equal((await route.PUT(adminRequest(USER, { conversation: "long" }))).status, 403);
	assert.equal(policy.conversationCacheRetention(), undefined, "a refused write changes nothing");

	const get = await route.GET(adminRequest(ADMIN));
	assert.deepEqual(await get.json(), { conversation: "short" });
	for (const bad of [{}, { conversation: "none" }, { conversation: 1 }, "long"]) {
		assert.equal((await route.PUT(adminRequest(ADMIN, bad))).status, 400, JSON.stringify(bad));
	}
	const put = await route.PUT(adminRequest(ADMIN, { conversation: "long" }));
	assert.deepEqual(await put.json(), { conversation: "long" });
	assert.deepEqual(await (await route.GET(adminRequest(ADMIN))).json(), { conversation: "long" });

	fs.writeFileSync(file, "{ not json");
	assert.equal((await route.PUT(adminRequest(ADMIN, { conversation: "short" }))).status, 500);
	assert.equal(fs.readFileSync(file, "utf-8"), "{ not json");
	fs.rmSync(file, { force: true });
});

test("the engine passes retention to pi-ai only when asked; an unset engine keeps the 5-minute cache", async () => {
	await runAsTenant(ADMIN, async () => {
		assert.equal(await wireTtl(piEngineForSpec(MODEL, { purpose: "teacher" })), undefined);
		assert.equal(await wireTtl(piEngineForSpec(MODEL, { purpose: "teacher", cacheRetention: "long" })), "1h");
	});
});

test("only the conversation turn engine carries the admin choice; compaction and role engines do not", async () => {
	policy.setConversationCacheRetention("long");
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage("hello")]);
	let turnEngine: PiEngine | undefined;
	const buildAgent = (opts: AgentBuildOptions & { teaching: boolean }): TeachingAgent => {
		turnEngine = opts.engine;
		return createTeacherAgent(undefined, { ...opts, engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
	};
	const chatId = runAsTenant(ADMIN, () => {
		const chat = stores.chatStore.createChat("Retention");
		stores.chatStore.saveSettings(chat.id, { model: MODEL });
		return chat.id;
	});
	await runAsTenant(ADMIN, async () => {
		const req = new Request("http://x/api/chat", { method: "POST", headers: headers(ADMIN), body: JSON.stringify({ chatId, input: { type: "text", text: "hi" } }) });
		const ack = await handleChatRequest(req, buildAgent);
		assert.equal(ack.status, 200);
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	});
	assert.ok(turnEngine, "the handler built the turn engine");
	const turn = turnEngine;
	await runAsTenant(ADMIN, async () => {
		assert.equal(await wireTtl(turn), "1h", "the learner's chat turn");
		const compaction = buildCompactionEngine(MODEL, null, { purpose: "compaction", chatId, chatKind: "teach" });
		assert.ok(compaction);
		assert.equal(await wireTtl(compaction), undefined, "compaction keeps the default");
		assert.equal(await wireTtl(piEngineForSpec(MODEL, { purpose: "extractor" })), undefined, "background roles keep the default");
	});
	policy.setConversationCacheRetention("short");
});
