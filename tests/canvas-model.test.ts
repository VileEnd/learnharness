/**
 * CANVAS TURNS RUN ON THE SESSION MODEL (owner, 2026-10-28): there is no canvas
 * model slot; the chat's model (else the strong slot) runs every turn, and the
 * canvas tools follow the chat setting and the device only. Drives
 * handleChatInput with the buildAgent seam, which receives the engine and the
 * canvas flag the handler resolved.
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
import { PATHS } from "../config.ts";
import { call, result } from "./learner-helpers.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const TUTOR = { provider: "openrouter", id: "qwen/qwen3.8-flash" };
const pose = (id = "w1") => [call(id, "work", { type: "check", nodeId: "n", question: "Sketch y = x^2", correctAnswer: "a parabola" }), result(id, "work", null)];

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

describe("canvas turns run on the session model", () => {
	it("a work submission and a hint run on the chat's model", async () => {
		const chat = chatWith(pose());
		assert.equal((await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "x" })).modelId, TUTOR.id);
		assert.equal((await turn(chat.id, { type: "hint", callId: "w1" })).modelId, TUTOR.id);
	});
	it("switching the chat's model moves the canvas turns with it", async () => {
		const chat = chatWith(pose(), { model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" } });
		assert.equal((await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "x" })).modelId, "deepseek/deepseek-v4.1-flash");
	});
});

describe("canvas tools follow the setting and the device only", () => {
	it("any model gets the canvas when the setting is on and the device can draw", async () => {
		const savedOa = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-presence-gate";
		try {
			const chat = chatWith(pose(), { model: { provider: "openai", id: "gpt-4" } });
			const seen = await turn(chat.id, { type: "work-submit", workCallId: "w1", text: "x" });
			assert.equal(seen.canvas, true);
			assert.equal(seen.modelId, "gpt-4");
		} finally {
			if (savedOa === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = savedOa;
		}
	});
	it("a phone turn (not canvas-capable) registers no canvas", async () => {
		const chat = chatWith(pose());
		assert.equal((await turn(chat.id, { type: "text", text: "hi" }, false)).canvas, false);
	});
});
