/** M4: visible feedback on every model (RC4 dedupe, RC9 silent turn + empty-error retry, RC10 phase recovery). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, createAssistantMessageEventStream, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import {
	asAgentMessages,
	hintsFor,
	newHandoffMessage,
	newHintRequest,
	newUserMessage,
	newWorkSubmission,
	openQuestionOf,
	redundantTextBlocks,
	userFacingTextOf,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { SILENT_TURN_STEER, PLAN_INIT_STEER } from "../src/agent/turn-nudge.ts";

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");

const MSG = "A parabola opens upward when the leading coefficient is positive, and its vertex is the lowest point.";
const asst = (id: string, content: unknown[]): LhMessage => ({ id, role: "assistant", content, stopReason: "stop" }) as unknown as LhMessage;
const send = (id: string, msg: string) => ({ type: "toolCall", id, name: "send_to_user", arguments: { message: msg } });
const ack = (id: string, callId: string): LhMessage => ({ id, role: "toolResult", toolCallId: callId, toolName: "send_to_user", isError: false, content: [] }) as unknown as LhMessage;
const user = (id: string): LhMessage => ({ ...newUserMessage("go"), id }) as LhMessage;
const textsOf = (v: ReturnType<typeof projectView>) =>
	v.filter((m) => m.role === "assistant").flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text));

describe("RC4 dedupe after send_to_user", () => {
	const turn = [user("u"), asst("a1", [send("s1", MSG)]), ack("r1", "s1"), asst("a2", [{ type: "text", text: MSG }]),
		asst("a3", [{ type: "text", text: "I marked up your sketch with two notes." }])];

	it("hides the duplicate text, keeps a distinct meta line", () => {
		assert.deepEqual(textsOf(projectView(turn)), [MSG, "I marked up your sketch with two notes."]);
		assert.equal(hintsFor([newHintRequest("w"), ...turn.slice(1)], "w")[0]!.text, `${MSG}\n\nI marked up your sketch with two notes.`);
		const md = sessionMarkdown(turn, { anchors: false });
		assert.equal(md.split("lowest point").length - 1, 1, "markdown carries the message once");
	});

	it("hides nothing in a turn without send_to_user (the #102 safety net)", () => {
		const m = [user("u"), asst("a2", [{ type: "text", text: MSG }]), asst("a3", [{ type: "text", text: MSG }])];
		assert.equal(redundantTextBlocks(m).size, 0);
		assert.deepEqual(textsOf(projectView(m)), [MSG, MSG]);
	});

	it("a send_to_user in an EARLIER turn hides nothing in this one", () => {
		const m = [user("u"), asst("a1", [send("s1", MSG)]), ack("r1", "s1"), user("u2"), asst("a2", [{ type: "text", text: MSG }])];
		assert.equal(redundantTextBlocks(m).size, 0);
	});

	// Final-review critical: overlap was measured against the SHORTER text, so a
	// short send_to_user hid any longer text that merely contained its words.
	const LONG = "Great work on the sketch. Now look again at the vertex: a parabola with a positive leading coefficient opens upward, "
		+ "so the vertex is the lowest point of the curve, and the axis of symmetry passes through it. Try marking that axis next.";

	it("a long teaching text next to a short send_to_user stays visible", () => {
		const m = [user("u"), asst("a1", [send("s1", "Great work on the sketch!")]), ack("r1", "s1"), asst("a2", [{ type: "text", text: LONG }])];
		assert.equal(redundantTextBlocks(m).size, 0);
		assert.deepEqual(textsOf(projectView(m)), ["Great work on the sketch!", LONG]);
		assert.equal(hintsFor([newHintRequest("w"), ...m.slice(1)], "w")[0]!.text, `Great work on the sketch!\n\n${LONG}`);
		assert.ok(sessionMarkdown(m, { anchors: false }).includes("axis of symmetry"), "markdown keeps the long text");
	});

	it("a short text whose words all occur in a long send_to_user stays visible", () => {
		const short = "Now look at the vertex next.";
		const m = [user("u"), asst("a1", [send("s1", LONG)]), ack("r1", "s1"), asst("a2", [{ type: "text", text: short }])];
		assert.equal(redundantTextBlocks(m).size, 0);
		assert.deepEqual(textsOf(projectView(m)), [LONG, short]);
	});

	it("a repeat with a short lead-in is still hidden", () => {
		const m = [user("u"), asst("a1", [send("s1", MSG)]), ack("r1", "s1"), asst("a2", [{ type: "text", text: `To recap: ${MSG}` }])];
		assert.equal(redundantTextBlocks(m).size, 1);
		assert.deepEqual(textsOf(projectView(m)), [MSG]);
	});

	it("coverage still counts both (userFacingTextOf without the set)", () => {
		assert.equal(userFacingTextOf(turn[3]!.role === "assistant" ? (turn[3] as { content: unknown }).content : []).length, 1);
	});
});

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({ provider: "openai", models: [{ id: "gpt-x" }] });
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, faux };
}
const ann = () => fauxToolCall("annotate", { marks: [] }, { id: "n1" });
const noop = {
	name: "annotate", label: "annotate", description: "x", parameters: { type: "object", properties: {} } as never, executionMode: "sequential" as const,
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: null }),
};
const runWith = async (steps: FauxResponseStep[], history: LhMessage[]) => {
	const { engine, faux } = scripted(steps);
	const agent = createTeacherAgent(undefined, { engine, tools: { annotate: noop as never }, messages: asAgentMessages(history) });
	await agent.continue();
	return { agent, faux };
};
const nudges = (agent: { state: { messages: unknown[] } }) => (agent.state.messages as Array<{ customType?: string }>).filter((m) => m.customType === "turn-nudge");

describe("RC9 silent post-submission turn", () => {
	it("re-prompts exactly once, and the steer never reaches the record", async () => {
		const { agent, faux } = await runWith(
			[fauxAssistantMessage([ann()], { stopReason: "toolUse" }), fauxAssistantMessage(""), fauxAssistantMessage(""), fauxAssistantMessage("never")],
			[{ ...newWorkSubmission("w1", "my sketch"), id: "m1" } as LhMessage],
		);
		assert.equal(faux.state.callCount, 3, "tool step, silent end, ONE re-prompt, then done");
		assert.equal(nudges(agent).length, 0);
		void SILENT_TURN_STEER;
	});

	it("the model sees the steer text and a spoken reply ends the turn", async () => {
		const seen: string[] = [];
		const { engine, faux } = scripted([fauxAssistantMessage(""), fauxAssistantMessage("You drew the vertex at x=2; check the sign next.")]);
		const spy: PiEngine = { ...engine, streamFn: (m, c, o) => { seen.push(JSON.stringify(c.messages)); return engine.streamFn(m, c, o); } };
		const agent = createTeacherAgent(undefined, { engine: spy, tools: {}, messages: asAgentMessages([{ ...newHintRequest("w1"), id: "m1" } as LhMessage]) });
		await agent.continue();
		assert.equal(faux.state.callCount, 2);
		assert.ok(seen[1]!.includes("tell him in plain text what you saw"));
	});

	it("no re-prompt when the turn spoke, or when no submission started it", async () => {
		const a = await runWith([fauxAssistantMessage("Looks good so far.")], [{ ...newWorkSubmission("w1", "s"), id: "m1" } as LhMessage]);
		assert.equal(a.faux.state.callCount, 1);
		const b = await runWith([fauxAssistantMessage("")], [user("u")]);
		assert.equal(b.faux.state.callCount, 1);
	});
});

describe("RC9 zero-event error retry", () => {
	const failing = (engine: PiEngine, failures: number): PiEngine => {
		let n = 0;
		return {
			...engine,
			streamFn: (m, c, o) => {
				if (n++ < failures) {
					const s = createAssistantMessageEventStream();
					const error = { ...fauxAssistantMessage(""), stopReason: "error" as const, errorMessage: "The operation was aborted", content: [] };
					s.push({ type: "error", reason: "error", error });
					s.end();
					return s;
				}
				return engine.streamFn(m, c, o);
			},
		};
	};
	it("retries the step once", async () => {
		const { engine, faux } = scripted([fauxAssistantMessage("hello there")]);
		const agent = createTeacherAgent(undefined, { engine: failing(engine, 1), tools: {}, messages: asAgentMessages([user("u")]) });
		await agent.continue();
		assert.equal(faux.state.callCount, 1);
		const last = agent.state.messages.at(-1) as { stopReason?: string };
		assert.equal(last.stopReason, "stop");
	});
	it("a second failure surfaces (one retry per turn)", async () => {
		const { engine } = scripted([fauxAssistantMessage("hello")]);
		const agent = createTeacherAgent(undefined, { engine: failing(engine, 2), tools: {}, messages: asAgentMessages([user("u")]) });
		await agent.continue();
		assert.equal((agent.state.messages.at(-1) as { stopReason?: string }).stopReason, "error");
	});
});

describe("RC9 retry that throws", () => {
	it("settles as an error step instead of hanging the turn", async () => {
		const { engine } = scripted([fauxAssistantMessage("unused")]);
		let n = 0;
		const throwing: PiEngine = {
			...engine,
			streamFn: () => {
				if (n++ > 0) throw new Error("socket exploded");
				const s = createAssistantMessageEventStream();
				const error = { ...fauxAssistantMessage(""), stopReason: "error" as const, errorMessage: "The operation was aborted", content: [] };
				s.push({ type: "error", reason: "error", error });
				s.end();
				return s;
			},
		};
		const agent = createTeacherAgent(undefined, { engine: throwing, tools: {}, messages: asAgentMessages([user("u")]) });
		await agent.continue();
		const last = agent.state.messages.at(-1) as { stopReason?: string; errorMessage?: string };
		assert.equal(last.stopReason, "error");
		assert.match(last.errorMessage ?? "", /socket exploded/);
	});
});

describe("RC10 phase recovery", () => {
	const handoff = (): LhMessage => ({ ...newHandoffMessage("c1") }) as LhMessage;
	const diagram = "Here is the plan:\n```mermaid\ngraph TD\n  a-->b\n```";
	it("steers once to plan_init when the plan was written as a diagram", async () => {
		const { faux, agent } = await runWith([fauxAssistantMessage(diagram), fauxAssistantMessage(diagram), fauxAssistantMessage("never")], [handoff()]);
		assert.equal(faux.state.callCount, 2, "one steer, not more");
		assert.equal(nudges(agent).length, 0);
		void PLAN_INIT_STEER;
	});
	it("no steer without a diagram", async () => {
		const { faux } = await runWith([fauxAssistantMessage("Let us begin.")], [handoff()]);
		assert.equal(faux.state.callCount, 1);
	});
	it("an interrupted question no longer counts as open for probe_done", () => {
		const quiz = asst("a1", [{ type: "toolCall", id: "q1", name: "quiz", arguments: {} }]);
		assert.notEqual(openQuestionOf([quiz]), null, "still open while nothing followed");
		assert.equal(openQuestionOf([quiz, user("u2")]), null, "superseded by learner input");
	});
});
