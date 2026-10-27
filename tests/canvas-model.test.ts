/**
 * THE CANVAS MODEL (owner, 2026-10-27): canvas input runs on the canvas model
 * slot, everything else on the tutor model; the canvas tools exist only when a
 * vetted canvas model resolves. Drives handleChatInput with the buildAgent
 * seam, which receives the engine and the canvas flag the handler resolved.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { isCanvasInput } from "../src/core/input-events.ts";
import { PATHS } from "../config.ts";
import { call, result } from "./learner-helpers.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const TUTOR = { provider: "openrouter", id: "qwen/qwen3.8-flash" };
const pose = (id = "w1") => [call(id, "work", { type: "check", nodeId: "n", question: "Sketch y = x^2", correctAnswer: "a parabola" }), result(id, "work", null)];
const practicePose = (canvas: boolean) => [call("p1", "problem", { statement: "Find the vertex", ...(canvas ? { canvas: true } : {}) }), result("p1", "problem", null)];

const created: string[] = [];
after(() => {
	for (const id of created) {
		try { fs.unlinkSync(path.join(PATHS.chats, `${id}.json`)); } catch { /* gone */ }
	}
});

function chatWith(messages: ReturnType<typeof pose>, settings: Record<string, unknown> = {}) {
	const chat = chatStore.createChat("canvas model");
	created.push(chat.id);
	chatStore.saveSettings(chat.id, { model: TUTOR, canvas: true, ...settings } as never);
	chatStore.saveMessages(chat.id, messages);
	return chat;
}

/** Run one turn through the handler; report what the handler resolved. */
async function turn(chatId: string, input: Parameters<typeof handleChatInput>[1], canvasCapable = true) {
	const seen: { modelId?: string; canvas?: boolean } = {};
	const res = await handleChatInput(
		chatId,
		input,
		(opts) => {
			seen.modelId = opts.engine!.model.id;
			seen.canvas = opts.canvas;
			const faux = createFauxCore({});
			faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
			return createTeacherAgent(undefined, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, messages: opts.messages });
		},
		{ canvasCapable },
	);
	assert.equal(res.status, 200, await res.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	return seen;
}

describe("which model runs the turn", () => {
	it("a work submission runs on the canvas model (default GLM); a normal turn runs on the tutor", async () => {
		const chat = chatWith(pose());
		const submit = await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "my first try" });
		assert.equal(submit.modelId, "z-ai/glm-5.3-flash");
		assert.equal(submit.canvas, true);
		const normal = await turn(chat.id, { type: "text", text: "what is a vertex?" });
		assert.equal(normal.modelId, TUTOR.id);
		assert.equal(normal.canvas, true, "the tools stay registered on the tutor turn (it poses the task)");
	});

	it("a hint on the canvas task runs on the canvas model", async () => {
		const chat = chatWith(pose());
		assert.equal((await turn(chat.id, { type: "hint", callId: "w1" })).modelId, "z-ai/glm-5.3-flash");
	});

	it("the per-chat pin keeps pinning the tutor, not the canvas model", async () => {
		const chat = chatWith(pose(), { model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" } });
		assert.equal((await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "x" })).modelId, "z-ai/glm-5.3-flash");
		assert.equal((await turn(chat.id, { type: "text", text: "hi" })).modelId, "deepseek/deepseek-v4.1-flash");
	});
});

describe("tools need a vetted canvas model", () => {
	it("no OpenRouter key and an unvetted strong model: no canvas, even with the setting on and a capable device", async () => {
		const savedOr = process.env.OPENROUTER_API_KEY;
		const savedOa = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-presence-gate";
		delete process.env.OPENROUTER_API_KEY;
		try {
			const chat = chatWith(pose(), { model: { provider: "openai", id: "gpt-4" } });
			const seen = await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "x" });
			assert.equal(seen.canvas, false);
			assert.equal(seen.modelId, "gpt-4", "no canvas model: the turn stays on the tutor");
		} finally {
			process.env.OPENROUTER_API_KEY = savedOr;
			if (savedOa === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = savedOa;
		}
	});

	it("a phone turn (not canvas-capable) registers no canvas even with a vetted model", async () => {
		const chat = chatWith(pose());
		assert.equal((await turn(chat.id, { type: "text", text: "hi" }, false)).canvas, false);
	});
});

describe("isCanvasInput", () => {
	it("work submissions, drawn practice thinking, and hints on canvas tasks or canvas problems", () => {
		assert.equal(isCanvasInput(pose(), { type: "work-submit", workCallId: "w1", text: "x" }), true);
		assert.equal(isCanvasInput(practicePose(true), { type: "thinking", problemCallId: "p1", text: "x", drawingId: "drw_1" }), true);
		assert.equal(isCanvasInput(practicePose(true), { type: "thinking", problemCallId: "p1", text: "x" }), false);
		assert.equal(isCanvasInput(pose(), { type: "hint", callId: "w1" }), true);
		assert.equal(isCanvasInput(practicePose(true), { type: "hint", callId: "p1" }), true);
		assert.equal(isCanvasInput(practicePose(false), { type: "hint", callId: "p1" }), false);
		assert.equal(isCanvasInput(pose(), { type: "text", text: "x" }), false);
		assert.equal(isCanvasInput(pose(), { type: "continue" }), false);
		assert.equal(isCanvasInput(pose(), { type: "steers", steers: [] }), false);
	});
});
