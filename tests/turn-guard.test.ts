/** Runaway-turn breaker and per-turn spend cap (turn-guard.ts). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PiEngine } from "../src/agent/models.ts";

const { createTeacherAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { BREAKER_FAILURE_LIMIT, STUCK_NOTICE, spendNotice, finalRefusal } = await import("../src/agent/turn-guard.ts");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({ provider: "openai", models: [{ id: "gpt-x" }] });
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, faux };
}

/** `bad` always fails; `read` always succeeds. */
function tools(): Record<string, AgentTool<any>> {
	const params = Type.Object({ path: Type.Optional(Type.String()) });
	const make = (name: string, isError: boolean): AgentTool<any> => ({
		name, label: name, description: name, parameters: params, executionMode: "sequential",
		execute: async () => ({ content: [{ type: "text", text: isError ? "nope" : "ok" }], details: null, isError }),
	});
	return { bad: make("bad", true), read: make("read", false) };
}
const call = (name: string, args: Record<string, string | { nested: boolean }>, id: string) => fauxToolCall(name, args, { id });
const step = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

type Msg = { role: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: unknown };
const resultsOf = (agent: { state: { messages: unknown[] } }, name: string) =>
	(agent.state.messages as Msg[]).filter((m) => m.role === "toolResult" && m.toolName === name);
const textOf = (m: Msg) => JSON.stringify(m.content);
const lastAssistantText = (agent: { state: { messages: unknown[] } }) => {
	const m = [...(agent.state.messages as Msg[])].reverse().find((x) => x.role === "assistant");
	return JSON.stringify(m?.content);
};

describe("identical-failure breaker", () => {
	it("3rd identical failure gets the final refusal, then immediate refusals", async () => {
		const same = { path: "a" };
		const { engine, faux } = scripted([
			step(call("bad", same, "c1")), step(call("bad", same, "c2")), step(call("bad", same, "c3")),
			step(call("bad", same, "c4")), fauxAssistantMessage("done"),
		]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools() });
		await agent.prompt("go");
		const rs = resultsOf(agent, "bad");
		assert.equal(rs.length, 4);
		assert.match(textOf(rs[0]!), /nope/);
		assert.match(textOf(rs[1]!), /nope/);
		assert.ok(textOf(rs[2]!).includes(finalRefusal("bad")), textOf(rs[2]!));
		assert.ok(textOf(rs[3]!).includes("unavailable for the rest of this turn"));
		assert.ok(rs.every((r) => r.isError));
		assert.equal(faux.state.callCount, 5, "one dropped call does not end the turn");
		assert.equal(BREAKER_FAILURE_LIMIT, 3);
	});

	it("two more calls to the dropped tool end the turn with the notice persisted", async () => {
		const same = { path: "a" };
		const { engine, faux } = scripted([
			step(call("bad", same, "c1")), step(call("bad", same, "c2")), step(call("bad", same, "c3")),
			step(call("bad", same, "c4")), step(call("bad", same, "c5")), fauxAssistantMessage("must not run"),
		]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools() });
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 5);
		assert.ok(lastAssistantText(agent).includes(STUCK_NOTICE));
		assert.equal(STUCK_NOTICE, "The tutor got stuck on a tool call; the turn was stopped. Send a message to continue.");
	});

	it("counts schema-validation failures that never reach execute (the Kimi loop)", async () => {
		const badArgs = { path: { nested: true } };
		const { engine } = scripted([
			step(call("read", badArgs, "c1")), step(call("read", badArgs, "c2")), step(call("read", badArgs, "c3")), fauxAssistantMessage("done"),
		]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools() });
		await agent.prompt("go");
		const rs = resultsOf(agent, "read");
		assert.ok(rs.every((r) => r.isError));
		assert.ok(textOf(rs[2]!).includes(finalRefusal("read")), textOf(rs[2]!));
	});

	it("applies to practice agents too", async () => {
		const { engine, faux } = scripted([
			step(call("bad", {}, "c1")), step(call("bad", {}, "c2")), step(call("bad", {}, "c3")),
			step(call("bad", {}, "c4")), step(call("bad", {}, "c5")), fauxAssistantMessage("must not run"),
		]);
		const agent = createPracticeAgent({} as never, { engine, tools: tools() });
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 5);
		assert.ok(lastAssistantText(agent).includes(STUCK_NOTICE));
	});

	it("different arguments do not trip it (key order is canonicalized)", async () => {
		const { engine, faux } = scripted([
			step(call("bad", { path: "a" }, "c1")), step(call("bad", { path: "b" }, "c2")),
			step(call("bad", { path: "c" }, "c3")), step(call("bad", { path: "d" }, "c4")),
			fauxAssistantMessage("done"),
		]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools() });
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 5);
		assert.ok(resultsOf(agent, "bad").every((r) => /nope/.test(textOf(r))));
	});

	it("successes are never counted and reset nothing", async () => {
		const same = { path: "a" };
		const { engine } = scripted([
			step(call("bad", same, "c1")), step(call("read", same, "r1")), step(call("bad", same, "c2")),
			step(call("read", same, "r2")), step(call("bad", same, "c3")), fauxAssistantMessage("done"),
		]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools() });
		await agent.prompt("go");
		assert.ok(textOf(resultsOf(agent, "bad")[2]!).includes(finalRefusal("bad")), "reads in between reset nothing");
		assert.ok(resultsOf(agent, "read").every((r) => !r.isError && /ok/.test(textOf(r))));
	});

	it("20 successful reads in a row are untouched", async () => {
		const steps: FauxResponseStep[] = [];
		for (let i = 0; i < 20; i++) steps.push(step(call("read", { path: "a" }, `r${i}`)));
		steps.push(fauxAssistantMessage("done"));
		const { engine, faux } = scripted(steps);
		const agent = createTeacherAgent(undefined, { engine, tools: tools() });
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 21);
		assert.ok(!lastAssistantText(agent).includes("stuck"));
	});
});

describe("per-turn spend cap", () => {
	it("stops the turn after the step that reaches the cap, with the notice", async () => {
		const { engine, faux } = scripted([
			step(call("read", { path: "1" }, "r1")), step(call("read", { path: "2" }, "r2")),
			step(call("read", { path: "3" }, "r3")), fauxAssistantMessage("must not run"),
		]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools(), spendCapUsd: 0.5, stepCost: () => 0.2 });
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 3, "0.2+0.2+0.2 >= 0.5 after the third step");
		assert.ok(lastAssistantText(agent).includes(spendNotice(0.5)));
		assert.equal(spendNotice(0.5), "This turn reached your spend limit of $0.50 (Settings → Agent). Send a message to continue.");
	});

	it("unknown cost counts as zero: no stop, no fake zero shown", async () => {
		const { engine, faux } = scripted([
			step(call("read", { path: "1" }, "r1")), step(call("read", { path: "2" }, "r2")), fauxAssistantMessage("done"),
		]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools(), spendCapUsd: 0.05, stepCost: () => null });
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 3);
		assert.ok(!lastAssistantText(agent).includes("spend limit"));
	});

	it("no cap configured means no stop", async () => {
		const { engine, faux } = scripted([step(call("read", {}, "r1")), fauxAssistantMessage("done")]);
		const agent = createTeacherAgent(undefined, { engine, tools: tools(), stepCost: () => 100 });
		await agent.prompt("go");
		assert.equal(faux.state.callCount, 2);
	});
});

describe("agent.turnSpendCapUsd settings", () => {
	it("defaults to 0.50; 0 and junk mean the default", () => {
		assert.equal(resolveSettings(null).agent.turnSpendCapUsd, 0.5);
		assert.equal(resolveSettings({ version: 1, agent: { turnSpendCapUsd: 0 } }).agent.turnSpendCapUsd, 0.5);
		assert.equal(resolveSettings({ version: 1, agent: { turnSpendCapUsd: 2 } }).agent.turnSpendCapUsd, 2);
	});
	it("write side accepts 0.05..20 and 0, rejects the rest", () => {
		for (const ok of [0.05, 0.5, 20]) {
			const r = parseAgentSettingsBody({ turnSpendCapUsd: ok });
			assert.ok(r.ok && r.settings.turnSpendCapUsd === ok, String(ok));
		}
		const zero = parseAgentSettingsBody({ turnSpendCapUsd: 0 });
		assert.ok(zero.ok && zero.settings.turnSpendCapUsd === undefined);
		for (const bad of [0.04, 20.01, -1, "1", null, Number.NaN]) {
			assert.equal(parseAgentSettingsBody({ turnSpendCapUsd: bad }).ok, false, String(bad));
		}
	});
});
