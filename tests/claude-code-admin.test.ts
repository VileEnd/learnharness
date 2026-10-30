/**
 * Claude Code as an admin-only provider, server wiring (Task 3): the admin
 * toggle (off by default), the gate (an admin's own chat turns only, before
 * the admin early-return), the catalog, the slots and policy refusals, the
 * unpriced pricer, the admin route and the compaction engine. Isolated
 * LH_DATA_DIR in multi-user mode, so every app-module import is dynamic. The
 * runner address points at a closed port: nothing here reaches a runner.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { QuestionData } from "../src/core/question-core.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-code-admin-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
process.env.OPENROUTER_API_KEY = "test-key-claude-code-admin";
process.env.CLAUDE_RUNNER_ADDR = "127.0.0.1:9";
process.env.CLAUDE_RUNNER_TOKEN = "test-runner-token";
delete process.env.LH_ADMIN_GROUP;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => {
	delete process.env.CLAUDE_RUNNER_ADDR;
	delete process.env.CLAUDE_RUNNER_TOKEN;
	fs.rmSync(dir, { recursive: true, force: true });
});

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { stores } = await import("../src/server/stores.ts");
const policy = await import("../src/server/policy.ts");
const { modelGate } = await import("../src/server/model-gate.ts");
const { ModelNotAllowedError } = await import("../src/core/settings.ts");
const { modelCatalog, catalogModels, catalogProviders, validateChatSettings, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { buildCompactionEngine, handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
const chatRoute = await import("../app/api/chat/route.ts");
const claudeCodeRoute = await import("../app/api/admin/claude-code/route.ts");

const SONNET = { provider: "claude-code", id: "sonnet" };
const STRONG = { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" };
const ADMIN = { id: "admin-a", name: "a", isAdmin: true };
const USER = { id: "user-b", name: "b", isAdmin: false };

const headers = (t: { id: string; isAdmin: boolean }) => ({
	"x-auth-request-user": t.id,
	"x-auth-request-groups": t.isAdmin ? "/learnharness,/learnharness-admin" : "/learnharness",
	"content-type": "application/json",
});

const chatPost = (t: { id: string; isAdmin: boolean }, chatId: string, input: unknown) =>
	new Request("http://x/api/chat", { method: "POST", headers: headers(t), body: JSON.stringify({ chatId, input }) });

function adminRequest(t: { id: string; isAdmin: boolean }, body?: unknown): Request {
	return new Request("http://x/api/admin/claude-code", {
		method: body === undefined ? "GET" : "PUT",
		headers: headers(t),
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

test("gate refuses non-admins even when allow-listed", () => {
	policy.setClaudeCodeEnabled(true);
	// Hand-written: the admin editor refuses it, so write the file directly.
	const file = path.join(dir, "global", "admin.json");
	const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
	const allowed = { slots: { strong: STRONG }, allowedModels: ["claude-code:sonnet"], monthlyCapUsd: null };
	stored.users[USER.id] = allowed;
	fs.writeFileSync(file, JSON.stringify(stored));
	runAsTenant(USER, () => {
		assert.throws(() => modelGate(SONNET, { purpose: "teacher", chatId: "c" }), ModelNotAllowedError);
	});
	assert.equal(policy.validatePolicy(allowed).ok, false);
	assert.equal(policy.validatePolicy({ slots: { strong: SONNET }, allowedModels: [], monthlyCapUsd: null }).ok, false);
});

/** Hand-write a user's policy into admin.json: the admin editor refuses claude-code. */
function handWritePolicy(userId: string, userPolicy: unknown): void {
	const file = path.join(dir, "global", "admin.json");
	const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
	stored.users[userId] = userPolicy;
	fs.writeFileSync(file, JSON.stringify(stored));
}

const DISALLOWED = { provider: "openrouter", id: "openai/gpt-5" };

for (const slot of ["strong", "cheap"] as const) {
	test(`a hand-written claude-code ${slot} slot is never a non-admin's fallback`, () => {
		policy.setClaudeCodeEnabled(true);
		const user = { id: `user-slot-${slot}`, name: slot, isAdmin: false };
		handWritePolicy(user.id, { slots: { [slot]: SONNET }, allowedModels: [], monthlyCapUsd: null });
		const cases = slot === "strong"
			? [{ purpose: "teacher", chatId: "c" }, { purpose: "compaction", chatId: "c" }]
			: [{ purpose: "extractor", role: "extractor" as const }, { purpose: "topicist", role: "describer" as const, chatId: "c" }];
		runAsTenant(user, () => {
			for (const opts of cases) {
				assert.throws(() => modelGate(DISALLOWED, opts), (err: unknown) => {
					assert(err instanceof ModelNotAllowedError, JSON.stringify(opts));
					assert.equal(err.envelope.model, `openrouter:${DISALLOWED.id}`, "the refusal names the requested model");
					return true;
				});
				let engine: PiEngine | undefined;
				assert.throws(() => { engine = piEngineForSpec(DISALLOWED, opts); }, ModelNotAllowedError, JSON.stringify(opts));
				assert.notEqual(engine?.model.provider, "claude-code");
			}
		});
	});
}

test("gate refuses background purposes for admins", () => {
	policy.setClaudeCodeEnabled(true);
	runAsTenant(ADMIN, () => {
		for (const opts of [{ purpose: "compaction", chatId: "c" }, { purpose: "teacher", role: "teacher" as const, chatId: "c" }, { purpose: "teacher" }]) {
			assert.throws(() => modelGate(SONNET, opts), ModelNotAllowedError, JSON.stringify(opts));
		}
	});
});

test("gate admits an admin chat turn only when enabled", () => {
	runAsTenant(ADMIN, () => {
		policy.setClaudeCodeEnabled(true);
		assert.deepEqual(modelGate(SONNET, { purpose: "prober", chatId: "c" }), SONNET);
		policy.setClaudeCodeEnabled(false);
		assert.throws(() => modelGate(SONNET, { purpose: "prober", chatId: "c" }), ModelNotAllowedError);
	});
});

test("demoted admin's pinned chat is refused", async () => {
	policy.setClaudeCodeEnabled(true);
	const DEMOTED = { id: "admin-demoted", name: "d", isAdmin: false };
	const chatId = runAsTenant({ ...DEMOTED, isAdmin: true }, () => {
		const chat = stores.chatStore.createChat("Pinned");
		stores.chatStore.saveSettings(chat.id, { model: SONNET });
		return chat.id;
	});
	const file = path.join(dir, "users", DEMOTED.id, "chats", `${chatId}.json`);
	const before = fs.readFileSync(file);
	const res = await chatRoute.POST(chatPost(DEMOTED, chatId, { type: "text", text: "hello" }));
	assert.equal(res.status, 403);
	assert.equal((await res.json()).code, "model_not_allowed");
	assert.deepEqual(fs.readFileSync(file), before);
});

test("toggle off mid-question refuses the answer turn readably", async () => {
	policy.setClaudeCodeEnabled(true);
	const quiz = {
		question: "Which planet is closest to the sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
		type: "check",
		nodeId: "planet-order",
	};
	const faux = createFauxCore({});
	faux.setResponses([() => fauxAssistantMessage([fauxToolCall("quiz", quiz, { id: "call-1" })], { stopReason: "toolUse" })]);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const buildAgent = (opts: AgentBuildOptions & { teaching: boolean }): TeachingAgent => createTeacherAgent(undefined, { ...opts, engine });
	const chatId = runAsTenant(ADMIN, () => {
		const chat = stores.chatStore.createChat("Held question");
		stores.chatStore.saveSettings(chat.id, { model: SONNET });
		stores.chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
		return chat.id;
	});
	await runAsTenant(ADMIN, async () => {
		const ack = await handleChatRequest(chatPost(ADMIN, chatId, { type: "text", text: "quiz me" }), buildAgent);
		assert.equal(ack.status, 200);
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	});
	policy.setClaudeCodeEnabled(false);
	const options = normalizeOptions(quiz.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: quiz.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(quiz.correctAnswer, options).indices,
		explanation: quiz.explanation,
		createdAt: new Date().toISOString(),
	};
	const answer = buildAnswer(qd, { values: ["Mercury"], thinking: "innermost", readingThinking: "ordering", confidence: 80 });
	const res = await runAsTenant(ADMIN, () => handleChatRequest(chatPost(ADMIN, chatId, { type: "answer", toolCallId: "call-1", answer }), buildAgent));
	assert.equal(res.status, 403);
	const body = await res.json();
	assert.equal(body.code, "model_not_allowed");
	assert.equal(typeof body.error, "string");
	assert.equal(runAsTenant(ADMIN, () => isTurnRunning(chatId)), false);
});

test("catalog lists claude-code only for an enabled admin", () => {
	const claudeIds = () => modelCatalog().models.filter((m) => m.provider === "claude-code");
	policy.setClaudeCodeEnabled(true);
	runAsTenant(ADMIN, () => {
		const listed = claudeIds();
		assert.deepEqual(listed.map((m) => m.id).sort(), ["haiku", "opus", "sonnet"]);
		assert(listed.every((m) => m.cost === null));
		assert(!catalogModels().some((m) => m.provider === "claude-code"));
		assert(!catalogProviders().some((p) => p.id === "claude-code"));
	});
	runAsTenant(USER, () => assert.deepEqual(claudeIds(), []));
	policy.setClaudeCodeEnabled(false);
	runAsTenant(ADMIN, () => assert.deepEqual(claudeIds(), []));
});

test("pricer leaves claude-code unpriced", () => {
	policy.setClaudeCodeEnabled(true);
	assert.equal(callCost({ inputTokens: 1000, outputTokens: 1000 }, "claude-code:sonnet"), null);
});

test("slots refuse claude-code", () => {
	policy.setClaudeCodeEnabled(true);
	runAsTenant(ADMIN, () => {
		assert.deepEqual(validateModelsSettings({ strong: { model: SONNET } }), { ok: false, error: "Claude Code models can't be used as a model slot." });
		// An unchanged saved pin is refused too: there is no grandfathered claude-code slot.
		assert.equal(validateModelsSettings({ strong: { model: SONNET } }, { strong: { model: SONNET } }).ok, false);
		assert.equal(validateChatSettings({ model: SONNET }).ok, true);
	});
	runAsTenant(USER, () => assert.equal(validateChatSettings({ model: SONNET }).ok, false));
});

test("admin route is admin-only", async () => {
	assert.equal((await claudeCodeRoute.GET(adminRequest(USER))).status, 403);
	assert.equal((await claudeCodeRoute.PUT(adminRequest(USER, { enabled: true }))).status, 403);
	for (const enabled of [true, false]) {
		const put = await claudeCodeRoute.PUT(adminRequest(ADMIN, { enabled }));
		assert.equal(put.status, 200);
		assert.deepEqual(await put.json(), { enabled });
		const get = await claudeCodeRoute.GET(adminRequest(ADMIN));
		const body = await get.json();
		assert.equal(body.enabled, enabled);
		assert.equal(body.status.state, "not-found");
	}
	assert.equal((await claudeCodeRoute.PUT(adminRequest(ADMIN, { enabled: "yes" }))).status, 400);
});

test("compaction of a claude-code chat runs on the strong slot", () => {
	policy.setClaudeCodeEnabled(true);
	runAsTenant(ADMIN, () => {
		const opts = { purpose: "compaction", chatId: "c", chatKind: "teach" as const };
		const engine = buildCompactionEngine(SONNET, STRONG, opts);
		assert(engine);
		assert.notEqual(engine.model.provider, "claude-code");
		assert.equal(engine.model.id, STRONG.id);
		assert.equal(buildCompactionEngine(SONNET, null, opts), null);
	});
});
