/** Teach-phase guard: a check question needs visible teaching first. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-teach-guard-"));
const originalEnv = process.env;
process.env = { ...originalEnv, NODE_ENV: "test", LH_DATA_DIR: path.join(scratch, "data"), LH_AUTH_FILE: path.join(scratch, "auth.json") };
after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { visibleTeachingSinceLastInput, SEND_TO_USER_TOOL, asAgentMessages, newUserMessage } = await import("../src/core/native-messages.ts");
const { createTeacherAgent, createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { teachExerciseToolFor } = await import("../src/agent/tools.ts");
const { projectView } = await import("../src/core/view.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

const LONG = "Teaching sentence about the chain rule. ".repeat(10); // > 200 non-ws chars

function assistant(content: unknown[], id = "a"): LhMessage {
	return { ...fauxAssistantMessage(""), content, id } as LhMessage;
}
function user(text = "go"): LhMessage {
	return newUserMessage(text);
}
function sendCall(message: string, id = "s1") {
	return { type: "toolCall", id, name: SEND_TO_USER_TOOL, arguments: { message } };
}
function result(callId: string, toolName: string, isError = false): LhMessage {
	return {
		id: `r-${callId}`, role: "toolResult", toolCallId: callId, toolName,
		content: [{ type: "text", text: "x" }], details: null, isError, timestamp: 1,
	} as LhMessage;
}

describe("visibleTeachingSinceLastInput (pure)", () => {
	it("false with nothing since the learner's input", () => {
		assert.equal(visibleTeachingSinceLastInput([user()], []), false);
		assert.equal(visibleTeachingSinceLastInput([user(), assistant([{ type: "text", text: "short" }])], []), false);
	});
	it("true for a 200+ char text block, in history or pending", () => {
		assert.equal(visibleTeachingSinceLastInput([user()], [assistant([{ type: "text", text: LONG }])]), true);
		assert.equal(visibleTeachingSinceLastInput([user(), assistant([{ type: "text", text: LONG }])], []), true);
	});
	it("whitespace padding does not count", () => {
		assert.equal(visibleTeachingSinceLastInput([user(), assistant([{ type: "text", text: "a" + " ".repeat(300) }])], []), false);
	});
	it("true for a successful send_to_user, false for a failed one", () => {
		assert.equal(visibleTeachingSinceLastInput([user()], [assistant([sendCall("hi")])]), true);
		assert.equal(visibleTeachingSinceLastInput([user()], [assistant([sendCall("hi")]), result("s1", SEND_TO_USER_TOOL, true)]), false);
	});
	it("teaching before the last input, answer result or marker does not count", () => {
		const taught = assistant([{ type: "text", text: LONG }]);
		assert.equal(visibleTeachingSinceLastInput([taught, user()], []), false);
		const q = assistant([{ type: "toolCall", id: "q", name: "quiz", arguments: {} }]);
		assert.equal(visibleTeachingSinceLastInput([taught, q, result("q", "quiz")], []), false);
		const marker = { id: "m", role: "custom", customType: "subagent-steer", content: "c", display: true, details: {}, timestamp: 1 } as unknown as LhMessage;
		assert.equal(visibleTeachingSinceLastInput([taught, marker], []), false);
	});
	it("a refused check (error result) is not an input boundary", () => {
		const msgs = [user(), assistant([sendCall("hi"), { type: "toolCall", id: "q", name: "quiz", arguments: {} }]), result("q", "quiz", true)];
		assert.equal(visibleTeachingSinceLastInput(msgs, []), true);
	});
});

function scripted(steps: FauxResponseStep[], provider = "anthropic", id = "claude-opus-5-5") {
	const faux = createFauxCore({ provider, models: [{ id }] });
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, faux };
}


function makeChat() {
	const chat = chatStore.createChat("Teach guard");
	const tree = { nodes: [{ id: "chain-rule", title: "Chain rule" }], edges: [], version: 1 };
	(chatStore as unknown as { saveTree: (id: string, t: unknown) => void }).saveTree(chat.id, tree);
	return chat;
}

function quizArgs(type: "check" | "predict" = "check") {
	return {
		type, nodeId: "chain-rule", question: "What is 2+2?",
		options: [{ label: "Four", value: "4" }, { label: "Five", value: "5" }],
		correctAnswer: "4", explanation: "Add.",
	};
}

function agentFor(chatId: string, engine: PiEngine) {
	return createTeacherAgent(
		{ chatId, chatStore, jobStore, spawn: () => {}, libraryRoot: "/nonexistent-library" },
		{ engine, messages: asAgentMessages([user("teach me")]) },
	);
}

describe("teach quiz/explain guard", () => {
	it("refuses a check without prose, then allows it after send_to_user (record renders the prose)", async () => {
		const chat = makeChat();
		const { engine, faux } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", quizArgs(), { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall(SEND_TO_USER_TOOL, { message: "The chain rule multiplies rates." }, { id: "s1" }), fauxToolCall("quiz", quizArgs(), { id: "q2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const agent = agentFor(chat.id, engine);
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 2);
		const results = agent.state.messages.filter((m) => m.role === "toolResult" && m.toolName === "quiz");
		assert.equal(results.length, 2);
		const first = results[0]!;
		assert.ok(first.role === "toolResult" && first.isError);
		const text = first.role === "toolResult" ? JSON.stringify(first.content) : "";
		assert.match(text, /No visible teaching reached the learner before this check/);
		assert.match(text, /send your teaching with `send_to_user`, then pose the check/);
		const ok = results[1]!;
		assert.ok(ok.role === "toolResult" && !ok.isError);
		const messages = agent.state.messages.map((m, i) => ({ ...m, id: `m${i}` })) as LhMessage[];
		const view = projectView(messages);
		const proseOut = view.filter((m) => m.role === "assistant").flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text));
		assert.deepEqual(proseOut, ["The chain rule multiplies rates."]);
	});

	it("non-send_to_user models are asked for normal text instead", async () => {
		const chat = makeChat();
		const { engine } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", quizArgs(), { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("stop"),
		], "openai", "gpt-x");
		const agent = agentFor(chat.id, engine);
		await agent.prompt("go");
		const r = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "quiz");
		const text = JSON.stringify(r && r.role === "toolResult" ? r.content : "");
		assert.match(text, /No visible teaching reached the learner before this check/);
		assert.doesNotMatch(text, /send_to_user/);
	});

	it("Claude through OpenRouter/Bedrock holds send_to_user, so the refusal never asks for normal text", async () => {
		for (const [provider, id] of [["openrouter", "anthropic/claude-opus-5.5"], ["amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0"]]) {
			const chat = makeChat();
			const { engine } = scripted([
				fauxAssistantMessage([fauxToolCall("quiz", quizArgs(), { id: "q1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("stop"),
			], provider, id);
			const agent = agentFor(chat.id, engine);
			await agent.prompt("go");
			const r = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "quiz");
			const text = JSON.stringify(r && r.role === "toolResult" ? r.content : "");
			assert.match(text, /send your teaching with `send_to_user`, then pose the check/, provider);
			assert.doesNotMatch(text, /normal text/, provider);
		}
	});

	it("allows a check after a 300-character text block", async () => {
		const chat = makeChat();
		const { engine, faux } = scripted([
			fauxAssistantMessage([fauxText("x".repeat(300)), fauxToolCall("quiz", quizArgs(), { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const agent = agentFor(chat.id, engine);
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 1);
		const r = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "quiz");
		assert.ok(r && r.role === "toolResult" && !r.isError);
	});

	it("allows a prediction without prose", async () => {
		const chat = makeChat();
		const { engine } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", quizArgs("predict"), { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const agent = agentFor(chat.id, engine);
		await agent.prompt("go");
		const r = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "quiz");
		assert.ok(r && r.role === "toolResult" && !r.isError);
	});

	it("the third attempt goes through (never loops forever)", async () => {
		const chat = makeChat();
		const { engine, faux } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", quizArgs(), { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("quiz", quizArgs(), { id: "q2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("quiz", quizArgs(), { id: "q3" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const agent = agentFor(chat.id, engine);
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
		try { await agent.prompt("go"); } finally { console.warn = warn; }
		assert.equal(faux.state.callCount, 3);
		const rs = agent.state.messages.filter((m) => m.role === "toolResult" && m.toolName === "quiz");
		assert.deepEqual(rs.map((r) => r.role === "toolResult" && r.isError), [true, true, false]);
		assert.equal(warnings.length, 1);
	});

	it("probe phase is never guarded", async () => {
		const chat = chatStore.createChat("Probe guard");
		const { engine } = scripted([
			fauxAssistantMessage([fauxToolCall("probe", {
				question: "What is 2+2?", options: [{ label: "Four", value: "4" }, { label: "Five", value: "5" }],
				correctAnswer: "4", explanation: "Add.",
			}, { id: "p1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const agent = createProberAgent(
			{ chatId: chat.id, chatStore, jobStore, deliver: () => {}, spawn: () => {}, libraryRoot: "/nonexistent-library" },
			{ engine, messages: asAgentMessages([user("assess me")]) },
		);
		await agent.prompt("go");
		const r = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "probe");
		assert.ok(r && r.role === "toolResult" && !r.isError);
	});
});

describe("teach exercise guard", () => {
	const exerciseArgs = (type: "check" | "predict") => ({
		type, nodeId: "chain-rule", question: "What is 3 times 4?", format: "numeric" as const,
		explanation: "Three groups of four.", spec: { answer: "12", mode: "number" },
		hints: ["Think of groups.", "Three groups, four in each."],
	});
	const run = async (messages: unknown[], type: "check" | "predict") => {
		const tool = teachExerciseToolFor(
			{ chatId: makeChat().id, chatStore, turn: { messages: () => messages, hasSendToUser: () => true } },
			["numeric"],
		);
		const r = await tool.execute("e1", exerciseArgs(type) as never);
		return { isError: (r as { isError?: boolean }).isError === true, text: JSON.stringify(r.content) };
	};

	it("refuses a check exercise with no visible teaching", async () => {
		const r = await run([user()], "check");
		assert.equal(r.isError, true);
		assert.match(r.text, /No visible teaching reached the learner before this check/);
	});

	it("allows a check exercise after visible teaching, and a prediction without it", async () => {
		assert.equal((await run([user(), assistant([{ type: "text", text: LONG }])], "check")).isError, false);
		assert.equal((await run([user()], "predict")).isError, false);
	});
});
