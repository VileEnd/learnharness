/**
 * WORK / SKETCH LIFECYCLE (PR 2, Task 9): the canvas task as a record
 * fold. A pose acks and ends the turn; submissions are markers; `grade`
 * (or a dismissal) closes the task. Mirrors practice-record /
 * dismissal-park for the practice problem.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	activeWorkOf,
	needsContinuation,
	endsInDismissal,
	newHintRequest,
	newWorkDismissedMarker,
	newWorkSubmission,
	newThinkingMessage,
	toLlmMessages,
	asAgentMessages,
	WORK_TOOLS,
	type LhMessage,
} from "../src/core/native-messages.ts";
import {
	ChatInputError,
	dismissAppends,
	inputAppends,
	parseChatInput,
	parseDismissInput,
} from "../src/core/input-events.ts";
import { projectView } from "../src/core/index.ts";
import { answeredRecallIds, gradedItems, ungradedAnsweredRecalls } from "../src/core/learner.ts";
import { createProberTools, createTeacherTools, teachQuizToolFor, type TeacherToolContext } from "../src/agent/tools.ts";
import { teachWorkToolFor, probeSketchToolFor } from "../src/agent/tools/work.ts";
import { probeDoneTool } from "../src/agent/tools/probe.ts";
import { gradeTool } from "../src/agent/tools/grade.ts";
import { workResult } from "../src/agent/tool-execute.ts";
import { workInputObject, sketchInputObject, workInputProblems, questionNeedsReveal } from "../src/core/question-core.ts";
import { chat, call, result } from "./learner-helpers.ts";

const WORK_ARGS = { type: "check", nodeId: "arith", question: "Sketch the graph of y = x^2", correctAnswer: "An upward parabola through the origin." };
const ACK = "Canvas task posed — the turn ends here; the learner's submissions arrive as labeled messages until you grade.";

/** A cleanly-acked work pose. */
function pose(id = "w1", tool: "work" | "sketch" = "work", args: Record<string, unknown> = WORK_ARGS): LhMessage[] {
	return [call(id, tool, args), result(id, tool, null)];
}
const gradeMsgs = (id: string, question: string, g = "correct", rung?: string): LhMessage[] => [
	call(id, "grade", { question, grade: g, note: "n", ...(rung !== undefined ? { rung } : {}) }),
	result(id, "grade", `Recorded: ${g}.`),
];
const drawingExists = (known: string[]) => (_chatId: string, id: string) => known.includes(id);

describe("the work fold", () => {
	it("work pose ack persists and does not auto-continue", () => {
		const messages = pose();
		assert.deepEqual(activeWorkOf(messages)?.toolCallId, "w1");
		assert.equal(activeWorkOf(messages)?.tool, "work");
		assert.equal(needsContinuation(messages), false);
		assert.equal(workResult().terminate, true);
		assert.equal((workResult().content[0] as { text: string }).text, ACK);
		assert.deepEqual([...WORK_TOOLS], ["work", "sketch"]);
	});

	it("an errored or dangling pose never activates", () => {
		assert.equal(activeWorkOf([call("w1", "work", WORK_ARGS)]), null);
		assert.equal(activeWorkOf([call("w1", "work", WORK_ARGS), result("w1", "work", null, 2, true)]), null);
	});

	it("submissions append markers while active; the model reads the labeled text", () => {
		const record = { id: "c1", messages: pose() };
		const [m] = inputAppends(record, { type: "work-submit", workCallId: "w1", text: "my first try", drawingId: "drw_abc" }, { drawingExists: drawingExists(["drw_abc"]) });
		const marker = m as { customType: string; content: string; details: unknown };
		assert.equal(marker.customType, "work-submission");
		assert.match(marker.content, /^Your thinking:\nmy first try\n\[drawing drw_abc\]$/);
		assert.deepEqual(marker.details, { workCallId: "w1", text: "my first try", drawingId: "drw_abc" });
		assert.equal(activeWorkOf([...record.messages, m!])?.toolCallId, "w1", "a submission keeps it active");
		assert.equal(newWorkSubmission("w1", "t").content.includes("[drawing"), false);
	});

	it("work-submit refused when no active work", () => {
		assert.throws(() => inputAppends({ id: "c1", messages: [] }, { type: "work-submit", workCallId: "w1", text: "x" }), ChatInputError);
		assert.throws(() => inputAppends({ id: "c1", messages: pose() }, { type: "work-submit", workCallId: "other", text: "x" }), ChatInputError);
	});

	it("work-submit refused for unknown drawing", () => {
		assert.throws(
			() => inputAppends({ id: "c1", messages: pose() }, { type: "work-submit", workCallId: "w1", text: "x", drawingId: "drw_nope" }, { drawingExists: drawingExists([]) }),
			/drawing/,
		);
	});

	it("parseChatInput validates work-submit and hint", () => {
		assert.deepEqual(parseChatInput({ type: "work-submit", workCallId: "w1", text: "x", drawingId: "d" }), { type: "work-submit", workCallId: "w1", text: "x", drawingId: "d" });
		assert.throws(() => parseChatInput({ type: "work-submit", text: "x" }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "work-submit", workCallId: "w1", text: "  " }), ChatInputError);
		assert.deepEqual(parseChatInput({ type: "hint", callId: "w1" }), { type: "hint", callId: "w1" });
		assert.throws(() => parseChatInput({ type: "hint" }), ChatInputError);
		assert.deepEqual(parseDismissInput({ type: "dismiss-work", workCallId: "w1" }), { type: "dismiss-work", workCallId: "w1" });
		assert.throws(() => parseDismissInput({ type: "dismiss-work" }), ChatInputError);
	});

	it("grade closes work", () => {
		const messages = [...pose(), ...gradeMsgs("g1", "w1")];
		assert.equal(activeWorkOf(messages), null);
		// an ERRORED grade closes nothing
		const bad = [...pose(), call("g1", "grade", { question: "w1", grade: "correct", note: "n" }), result("g1", "grade", "no", 2, true)];
		assert.equal(activeWorkOf(bad)?.toolCallId, "w1");
	});

	it("dismiss-work closes and pauses wake", () => {
		const record = { messages: pose() };
		const appends = dismissAppends(record, { type: "dismiss-work", workCallId: "w1" });
		assert.equal((appends[0] as { customType: string }).customType, "work-dismissed");
		const after = [...record.messages, ...appends];
		assert.equal(activeWorkOf(after), null);
		assert.equal(endsInDismissal(after), true);
		assert.equal(needsContinuation(after), false);
		assert.throws(() => dismissAppends(record, { type: "dismiss-work", workCallId: "nope" }), ChatInputError);
		assert.throws(() => dismissAppends({ messages: [] }, { type: "dismiss-work", workCallId: "w1" }), ChatInputError);
		assert.equal(newWorkDismissedMarker("w1").customType, "work-dismissed");
	});

	it("quiz allowed while work open; work-submit refused until it is answered", () => {
		const open = [...pose(), call("q1", "quiz", { question: "side?" })];
		assert.throws(() => inputAppends({ id: "c1", messages: open }, { type: "work-submit", workCallId: "w1", text: "x" }), /side question|answer/i);
		assert.throws(() => inputAppends({ id: "c1", messages: open }, { type: "hint", callId: "w1" }), ChatInputError);
		// once the quiz is answered the submission lands
		const answered = [...pose(), call("q1", "quiz", { question: "side?" }), result("q1", "quiz", { kind: "quiz", answers: [] })];
		assert.equal(inputAppends({ id: "c1", messages: answered }, { type: "work-submit", workCallId: "w1", text: "x" }).length, 1);
	});

	it("hint input appends a marker for the active task only", () => {
		const [h] = inputAppends({ id: "c1", messages: pose() }, { type: "hint", callId: "w1" });
		const marker = h as { customType: string; content: string; details: unknown };
		assert.equal(marker.customType, "hint-request");
		assert.equal(marker.content, "Hint, please — give the next rung only.");
		assert.deepEqual(marker.details, { callId: "w1" });
		assert.equal(newHintRequest("x").customType, "hint-request");
		assert.throws(() => inputAppends({ id: "c1", messages: pose() }, { type: "hint", callId: "w2" }), ChatInputError);
		assert.throws(() => inputAppends({ id: "c1", messages: [...pose(), ...gradeMsgs("g1", "w1")] }, { type: "hint", callId: "w1" }), ChatInputError);
		// the active practice problem is valid too
		const problem = [call("p1", "problem", { statement: "s", mode: "recall", modelSolution: "m" }), result("p1", "problem", null)];
		assert.equal(inputAppends({ id: "c1", messages: problem, kind: "practice" }, { type: "hint", callId: "p1" }).length, 1);
	});

	it("markers: wire text, view parts", () => {
		const sub = newWorkSubmission("w1", "my try", "drw_a");
		const dismissed = newWorkDismissedMarker("w1");
		const wire = toLlmMessages(asAgentMessages([...pose(), sub, newHintRequest("w1")]));
		const texts = wire.filter((w) => w.role === "user").map((w) => JSON.stringify(w.content));
		assert.ok(texts.some((t) => t.includes("Your thinking:") && t.includes("[drawing drw_a]")));
		assert.ok(texts.some((t) => t.includes("Hint, please")));
		const view = projectView([...pose(), sub, dismissed] as never);
		const types = view.flatMap((m) => m.parts.map((p) => p.type));
		assert.ok(types.includes("data-work-submission"));
		assert.ok(types.includes("data-work-dismissed"));
		// the pose is a placeholder tool part, never output-available
		const poseView = projectView(pose() as never);
		const posePart = poseView.flatMap((m) => m.parts).find((p) => p.type === "tool-work") as { state?: string } | undefined;
		assert.equal(posePart?.state, "input-available");
	});
});

describe("work as evidence", () => {
	const subs = (id: string) => [newWorkSubmission(id, "first"), newWorkSubmission(id, "final answer", "drw_z")];

	it("an answered work call is gradeable; graded work becomes evidence", () => {
		const msgs = [...pose(), ...subs("w1")];
		assert.deepEqual([...answeredRecallIds(msgs)], ["w1"]);
		assert.deepEqual(ungradedAnsweredRecalls(msgs), ["w1"]);
		assert.deepEqual(gradedItems(chat("c1", msgs)), []);
		const graded = [...msgs, ...gradeMsgs("g1", "w1", "correct")];
		assert.deepEqual(ungradedAnsweredRecalls(graded), []);
		const [item] = gradedItems(chat("c1", graded));
		assert.equal(item?.kind, "work");
		assert.equal(item?.raw, "correct");
		assert.equal(item?.result, "clean");
		assert.equal(item?.answer, "final answer [drawing]");
		assert.equal(item?.correct, WORK_ARGS.correctAnswer);
	});

	it("a work call with no submission is not answered", () => {
		assert.equal(answeredRecallIds(pose()).size, 0);
	});

	it("work graded correct at R3 is weak evidence", () => {
		const base = [...pose(), ...subs("w1")];
		const r1 = gradedItems(chat("c1", [...base, ...gradeMsgs("g1", "w1", "correct", "R1")]))[0]!;
		assert.equal(r1.result, "clean");
		const r3 = gradedItems(chat("c1", [...base, ...gradeMsgs("g1", "w1", "correct", "R3")]))[0]!;
		assert.equal(r3.raw, "correctWithHelp");
		assert.equal(r3.result, "weak");
		const wrong = gradedItems(chat("c1", [...base, ...gradeMsgs("g1", "w1", "wrong", "R3")]))[0]!;
		assert.equal(wrong.result, "failed");
	});

	it("sketch is evidence; a predicted work is not", () => {
		const sk = [...pose("s1", "sketch", { question: "q", correctAnswer: "a" }), newWorkSubmission("s1", "t"), ...gradeMsgs("g1", "s1", "partly")];
		assert.equal(gradedItems(chat("c1", sk))[0]?.kind, "sketch");
		const pred = [...pose("w1", "work", { ...WORK_ARGS, type: "predict" }), newWorkSubmission("w1", "t"), ...gradeMsgs("g1", "w1")];
		assert.deepEqual(gradedItems(chat("c1", pred)), []);
	});

	it("the grade tool accepts a work call id and takes a rung", async () => {
		const msgs = [...pose(), newWorkSubmission("w1", "t")];
		const tool = gradeTool({ chatId: "c1", chatStore: { getChat: () => chat("c1", msgs) } as never });
		assert.ok(Value.Check(tool.parameters, { question: "w1", grade: "correct", note: "n", rung: "R2" }));
		assert.ok(Value.Check(tool.parameters, { question: "w1", grade: "correct", note: "n", rung: null }));
		assert.equal(Value.Check(tool.parameters, { question: "w1", grade: "correct", note: "n", rung: "R9" }), false);
		const r = (await tool.execute("g", { question: "w1", grade: "correct", note: "n", rung: "R2" } as never)) as { isError?: boolean };
		assert.ok(!r.isError);
		const none = (await tool.execute("g", { question: "w9", grade: "correct", note: "n" } as never)) as { isError?: boolean };
		assert.equal(none.isError, true);
	});
});

describe("the tools", () => {
	const record = (messages: LhMessage[]) => ({ ...chat("c1", messages), tree: { nodes: [{ id: "arith", title: "A" }], edges: [], version: 1 } });
	const ctxOf = (messages: LhMessage[], extra: Record<string, unknown> = {}) =>
		({
			chatId: "c1",
			chatStore: { getChat: () => record(messages) },
			jobStore: {},
			spawn: () => {},
			libraryRoot: "/nonexistent",
			...extra,
		}) as unknown as TeacherToolContext;
	const run = async (tool: { execute: (id: string, input: never) => Promise<unknown> }, input: unknown) =>
		(await tool.execute("c", input as never)) as { isError?: boolean; terminate?: boolean; content: { text: string }[] };

	it("schemas and the quiz-rule reveal", () => {
		assert.ok(Value.Check(workInputObject, WORK_ARGS));
		assert.ok(Value.Check(sketchInputObject, { question: "q", correctAnswer: "a", requireThinking: true, details: "d", concepts: ["x"] }));
		assert.deepEqual(workInputProblems({ correctAnswer: " ", question: "q" }).length, 1);
		assert.equal(questionNeedsReveal("work", { type: "check" }, "teach"), true);
		assert.equal(questionNeedsReveal("work", { type: "predict" }, "teach"), false);
		assert.equal(questionNeedsReveal("sketch", {}, "probe"), false);
	});

	it("work pose returns the terminating ack; second work refused while one is open", async () => {
		const tool = teachWorkToolFor(ctxOf([]));
		const ok = await run(tool, WORK_ARGS);
		assert.ok(!ok.isError);
		assert.equal(ok.terminate, true);
		const second = await run(teachWorkToolFor(ctxOf(pose())), WORK_ARGS);
		assert.equal(second.isError, true);
		assert.match(second.content[0]!.text, /already open|one canvas task/i);
		const sketch = await run(probeSketchToolFor({ chatId: "c1", chatStore: { getChat: () => chat("c1", pose("s1", "sketch", { question: "q", correctAnswer: "a" })) } as never }), { question: "q", correctAnswer: "a" });
		assert.equal(sketch.isError, true);
		// closed by grade -> a new one is fine
		const closed = await run(teachWorkToolFor(ctxOf([...pose(), ...gradeMsgs("g1", "w1")])), WORK_ARGS);
		assert.ok(!closed.isError);
	});

	it("validates nodeId and the commitment", async () => {
		const tool = teachWorkToolFor(ctxOf([]));
		assert.equal((await run(tool, { ...WORK_ARGS, nodeId: "nope" })).isError, true);
		assert.equal((await run(tool, { ...WORK_ARGS, correctAnswer: "  " })).isError, true);
	});

	it("side questions stay allowed while a task is open", async () => {
		const quiz = teachQuizToolFor({ chatId: "c1", chatStore: { getChat: () => record(pose()) } as never });
		const r = await run(quiz, { type: "predict", nodeId: "arith", question: "q", options: [{ label: "a", value: "a" }, { label: "b", value: "b" }], correctAnswer: "a", explanation: "e" });
		assert.ok(!r.isError, r.content[0]?.text);
	});

	it("the teach guard covers a work check, not a prediction", async () => {
		const turn = { messages: () => [], hasSendToUser: () => false };
		const tool = teachWorkToolFor({ ...ctxOf([]), turn } as never);
		const refused = await run(tool, WORK_ARGS);
		assert.equal(refused.isError, true);
		assert.match(refused.content[0]!.text, /No visible teaching/);
		assert.ok(!(await run(teachWorkToolFor({ ...ctxOf([]), turn } as never), { ...WORK_ARGS, type: "predict" })).isError);
	});

	it("grade armed when canvas on; work tool only on canvas-capable turns", () => {
		const choice = { quizMechanic: "choice" as const };
		const names = (t: Record<string, unknown>) => Object.keys(t);
		assert.ok(!names(createTeacherTools(ctxOf([], choice))).includes("grade"));
		assert.ok(!names(createTeacherTools(ctxOf([], choice))).includes("work"));
		const on = names(createTeacherTools(ctxOf([], { ...choice, canvas: true })));
		assert.ok(on.includes("grade") && on.includes("work"));
		const prober = names(createProberTools({ ...ctxOf([], { ...choice, canvas: true }) } as never));
		assert.ok(prober.includes("sketch") && prober.includes("grade"));
		assert.ok(!names(createProberTools({ ...ctxOf([], choice) } as never)).includes("sketch"));
	});

	it("phone turn has no work tool but keeps grade", () => {
		const open = [...pose(), newWorkSubmission("w1", "t")];
		const tools = Object.keys(createTeacherTools(ctxOf(open, { quizMechanic: "choice", canvas: false })));
		assert.ok(tools.includes("grade"));
		assert.ok(!tools.includes("work"));
	});

	it("probe_done refused during open sketch", async () => {
		const msgs = pose("s1", "sketch", { question: "q", correctAnswer: "a" });
		const tools = probeDoneTool({ chatId: "c1", chatStore: { getChat: () => chat("c1", msgs) } as never, deliver: () => {} } as never);
		const r = (await tools.probe_done!.execute("p", { assessment: "x" } as never)) as { isError?: boolean; content: { text: string }[] };
		assert.match(JSON.stringify(r), /canvas task|sketch/i);
	});
});

describe("practice thinking drawing hook is untouched", () => {
	it("newThinkingMessage keeps its shape", () => {
		assert.equal(newThinkingMessage("p1", "t").customType, "practice-thinking");
	});
});
