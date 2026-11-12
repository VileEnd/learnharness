/**
 * TOOLS SEE THE RECORD'S CALL ID. Some providers restart tool-call ids in
 * every response (`call_0` again and again); the handler uniquifies them
 * for the stream and the record (src/server/pi/call-ids.ts), and the tools
 * must see the SAME id: a job keyed by the raw id would be found again by
 * the next call that reuses it (a second dispatch spawning nothing), and the
 * canvas ack would name an id the record does not hold. Scripted faux
 * engine, driven through the real handler; no network.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { JobRecord } from "../src/core/contracts.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tool-call-ids-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
delete process.env.LH_MULTI_USER;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { createPracticeAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

after(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

const RESEARCH = { question: "What is the current stable version?" };
const WORK = { type: "predict", nodeId: "arith", question: "Sketch y = x^2", correctAnswer: "An upward parabola through the origin." };

function engineOf(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A research call that reuses `call_0`, like a provider that restarts ids. */
const research = () => fauxAssistantMessage([fauxToolCall("research", RESEARCH, { id: "call_0" })], { stopReason: "toolUse" });

async function turn(chatId: string, engine: PiEngine, spawned: JobRecord[], text: string): Promise<void> {
	// The real handler hands the factory its build options; the factory passes
	// them on to the agent exactly as production does.
	const buildAgent = (opts: AgentBuildOptions): TeachingAgent =>
		createTeacherAgent(
			{ chatId, chatStore, jobStore, spawn: (job) => void spawned.push(job), libraryRoot: scratch, canvas: true },
			{ ...opts, engine },
		);
	const ack = await handleChatRequest(
		new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text }, canvasCapable: true }),
		}),
		buildAgent,
	);
	assert.equal(ack.status, 200);
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

function newChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, canvas: true });
	chatStore.saveTree(chat.id, { nodes: [{ id: "arith", title: "Arithmetic" }], edges: [], version: 1 });
	return chat;
}

/** The tool parts of a kind in the record: [toolCallId, result text]. */
function callsOf(chatId: string, toolName: string): Array<{ id: string; text: string }> {
	const messages = chatStore.getChat(chatId)!.messages as unknown as Array<Record<string, any>>;
	const out: Array<{ id: string; text: string }> = [];
	for (const m of messages) {
		if (m.role !== "toolResult" || m.toolName !== toolName) continue;
		out.push({ id: m.toolCallId, text: m.content.map((c: { text?: string }) => c.text ?? "").join("") });
	}
	return out;
}

describe("tools see the id the record uses", () => {
	it("a provider that reuses call_0 gets one job per dispatch, keyed by the record's id", async () => {
		const chat = newChat("Test: reused ids");
		const spawned: JobRecord[] = [];
		// Turn 1 holds two dispatches in two responses; turn 2 one more.
		await turn(chat.id, engineOf([research(), research(), fauxAssistantMessage([fauxText("Waiting for the briefs.")])]), spawned, "first");
		await turn(chat.id, engineOf([research(), fauxAssistantMessage([fauxText("Another brief is on its way.")])]), spawned, "second");

		assert.equal(spawned.length, 3, "every dispatch spawned its own job");
		assert.equal(new Set(spawned.map((j) => j.id)).size, 3, "three distinct jobs");
		const parts = callsOf(chat.id, "research");
		assert.deepEqual(parts.map((p) => p.id), ["call_0", "call_0~2", "call_0~3"], "the record's ids are unique");
		assert.deepEqual(spawned.map((j) => j.toolCallId), parts.map((p) => p.id), "each job is keyed by its tool part's id");
		parts.forEach((p, i) => assert.ok(p.text.includes(`job ${spawned[i]!.id}`), `part ${p.id} acknowledges its own job`));
	});

	it("distinct provider ids behave exactly as before: stored and named unchanged", async () => {
		const chat = newChat("Test: unique ids");
		const spawned: JobRecord[] = [];
		const call = (id: string, tool: "research" | "work") =>
			fauxAssistantMessage([fauxToolCall(tool, tool === "work" ? WORK : RESEARCH, { id })], { stopReason: "toolUse" });
		await turn(chat.id, engineOf([call("toolu_a", "research"), call("toolu_b", "research"), call("toolu_c", "work")]), spawned, "go");

		assert.deepEqual(spawned.map((j) => j.toolCallId), ["toolu_a", "toolu_b"], "jobs keep the provider's ids");
		assert.deepEqual(callsOf(chat.id, "research").map((p) => p.id), ["toolu_a", "toolu_b"]);
		const [pose] = callsOf(chat.id, "work");
		assert.equal(pose?.id, "toolu_c");
		assert.ok(pose!.text.includes('question "toolu_c"'), pose!.text);
	});

	it("two calls with different raw ids in one response, both already in the record, each get their own job", async () => {
		const chat = newChat("Test: reused ids, parallel");
		const spawned: JobRecord[] = [];
		const both = () =>
			fauxAssistantMessage(
				[fauxToolCall("research", RESEARCH, { id: "call_a" }), fauxToolCall("research", { question: "A second question?" }, { id: "call_b" })],
				{ stopReason: "toolUse" },
			);
		await turn(chat.id, engineOf([both(), fauxAssistantMessage([fauxText("Waiting.")])]), spawned, "first");
		await turn(chat.id, engineOf([both(), fauxAssistantMessage([fauxText("Waiting again.")])]), spawned, "second");

		assert.equal(spawned.length, 4, "every dispatch spawned its own job");
		const parts = callsOf(chat.id, "research");
		assert.deepEqual(parts.map((p) => p.id).sort(), ["call_a", "call_a~2", "call_b", "call_b~2"]);
		for (const p of parts) {
			const job = spawned.find((j) => j.toolCallId === p.id);
			assert.ok(job, `a job is keyed by ${p.id}`);
			assert.ok(p.text.includes(`job ${job.id}`), `part ${p.id} acknowledges its own job`);
		}
	});

	it("the canvas ack names the id the record holds", async () => {
		const chat = newChat("Test: reused ids, canvas");
		const spawned: JobRecord[] = [];
		await turn(chat.id, engineOf([research(), fauxAssistantMessage([fauxToolCall("work", WORK, { id: "call_0" })], { stopReason: "toolUse" })]), spawned, "pose it");

		const [pose] = callsOf(chat.id, "work");
		assert.ok(pose, "work was posed");
		assert.equal(pose.id, "call_0~2");
		assert.ok(pose.text.includes('question "call_0~2"'), `the ack must name the record's id: ${pose.text}`);
	});

	it("the practice agent's research tool resolves ids too", async () => {
		const chat = newChat("Test: reused ids, practice");
		const spawned: JobRecord[] = [];
		const agent = createPracticeAgent(
			{ chatId: chat.id, chatStore, libraryRoot: scratch, jobs: { chatId: chat.id, jobStore, spawn: (job) => void spawned.push(job) } },
			{ engine: engineOf([]), resolveCallId: (id) => `${id}~2` },
		);
		const tool = agent.state.tools.find((t) => t.name === "research")!;
		await tool.execute("call_0", RESEARCH);
		assert.deepEqual(spawned.map((j) => j.toolCallId), ["call_0~2"]);
	});
});
