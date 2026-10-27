/**
 * The exercise / assess question tools: registration, the authoring contract
 * (spec, hints, nodeId), the answer record and its model-facing compaction.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createProberTools, createTeacherTools, probeExerciseToolFor, teachExerciseToolFor, type TeacherToolContext } from "../src/agent/tools.ts";
import { buildExerciseAnswer, compactAnswerForModel, questionNeedsReveal } from "../src/core/question-core.ts";
import { hintLeaks } from "../src/core/exercise-core.ts";
import { parseExerciseInput } from "../src/core/tool-parts.ts";
import { toolQuestionKind } from "../src/core/pending.ts";
import { asAgentMessages, type LhMessage } from "../src/core/native-messages.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PATHS } from "../config.ts";

fs.mkdirSync(path.join(PATHS.root, "data"), { recursive: true });
const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup */
		}
	}
});
function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "arith", title: "Arithmetic" }], edges: [], version: 1 });
	return chat.id;
}

type Problems = AgentToolResult<{ tool: string; problems: string[] }>;
async function run(
	tool: { parameters: any; execute: (id: string, input: never) => Promise<unknown> },
	input: unknown,
): Promise<{ ok: boolean; problems: string[] }> {
	if (!Value.Check(tool.parameters, input)) return { ok: false, problems: ["schema"] };
	const r = (await tool.execute("tc", input as never)) as Problems;
	return r.isError ? { ok: false, problems: r.details.problems } : { ok: true, problems: [] };
}

const numericSpec = { answer: "12", mode: "number" };
const base = {
	question: "What is 3 times 4?",
	format: "numeric",
	explanation: "Three groups of four.",
	spec: numericSpec,
	hints: ["Think of groups.", "Three groups, four in each."],
};
const teachCall = { type: "check", nodeId: "arith", ...base };

const ctx = (chatId: string, formats?: string[]): TeacherToolContext =>
	({
		chatId,
		chatStore,
		jobStore,
		spawn: () => {},
		libraryRoot: PATHS.root,
		...(formats ? { formats } : {}),
	}) as unknown as TeacherToolContext;

describe("registration", () => {
	it("exercise tool absent when formats empty", () => {
		const chatId = newChat("none");
		assert.equal("exercise" in createTeacherTools(ctx(chatId)), false);
		assert.equal("exercise" in createTeacherTools(ctx(chatId, [])), false);
		assert.equal("exercise" in createTeacherTools(ctx(chatId, ["numeric"])), true);
		const prober = (formats?: string[]) =>
			createProberTools({ ...ctx(chatId, formats), chatId } as never);
		assert.equal("assess" in prober(), false);
		assert.equal("assess" in prober(["numeric"]), true);
	});

	it("format enum lists only enabled formats", () => {
		const tool = teachExerciseToolFor({ chatId: newChat("enum"), chatStore }, ["numeric", "table"]);
		const format = (tool.parameters as any).properties.format;
		assert.deepEqual(format.anyOf.map((l: { const: string }) => l.const), ["numeric", "table"]);
		assert.match(tool.description, /numeric:/);
		assert.match(tool.description, /table:/);
		assert.doesNotMatch(tool.description, /blanks:/);
		assert.equal(Value.Check(tool.parameters, { ...teachCall, format: "blanks" }), false);
	});

	it("the exercise tools are question tools of kind exercise", () => {
		assert.equal(toolQuestionKind("exercise"), "exercise");
		assert.equal(toolQuestionKind("assess"), "exercise");
		assert.equal(questionNeedsReveal("exercise", { type: "check" }, "teach"), true);
		assert.equal(questionNeedsReveal("exercise", { type: "predict" }, "teach"), false);
		assert.equal(questionNeedsReveal("assess", {}, "probe"), false);
	});
});

describe("the authoring contract", () => {
	const teach = () => teachExerciseToolFor({ chatId: newChat("auth"), chatStore }, ["numeric", "blanks", "table"]);

	it("accepts a valid exercise", async () => {
		assert.equal((await run(teach(), teachCall)).ok, true);
	});

	it("assess rejects an ungradeable spec", async () => {
		const tool = probeExerciseToolFor({}, ["table"]);
		const noEditable = { columns: ["a"], rows: [{ cells: [{ given: "1" }] }] };
		const r = await run(tool, { ...base, format: "table", spec: noEditable });
		assert.equal(r.ok, false);
		assert.match(r.problems.join("\n"), /at least one editable cell/);
	});

	it("exercise requires 2-3 hints", async () => {
		const tool = teach();
		for (const hints of [[], ["one"], ["a", "b", "c", "d"]]) {
			const r = await run(tool, { ...teachCall, hints });
			assert.equal(r.ok, false, `${hints.length} hints`);
			assert.match(r.problems.join("\n"), /2 or 3/);
		}
		assert.equal((await run(tool, { ...teachCall, hints: ["a b", "c d", "e f"] })).ok, true);
	});

	it("exercise refuses a hint that leaks an accepted answer", async () => {
		const r = await run(teach(), { ...teachCall, hints: ["Think.", "The result is 12."] });
		assert.equal(r.ok, false);
		assert.match(r.problems.join("\n"), /accepted answer "12"/);
	});

	it("exercise refuses an unknown nodeId", async () => {
		const r = await run(teach(), { ...teachCall, nodeId: "nope" });
		assert.equal(r.ok, false);
		assert.match(r.problems.join("\n"), /matches no node/);
	});

	it("hintLeaks compares case- and whitespace-insensitively and ignores 1-character values", () => {
		const spec = { text: "{{a}} {{b}}", blanks: [{ id: "a", accept: ["Light  Blue"] }, { id: "b", accept: ["x"] }] };
		assert.deepEqual(hintLeaks("blanks", spec, ["it is LIGHT blue, right?", "x marks the spot"]), ["light blue"]);
		assert.deepEqual(hintLeaks("blanks", spec, ["no leak"]), []);
	});

	it("hintLeaks matches whole tokens only", () => {
		const blanks = { text: "I live {{a}} Berlin.", blanks: [{ id: "a", accept: ["in"] }] };
		assert.deepEqual(hintLeaks("blanks", blanks, ["Think about the preposition used for cities."]), []);
		assert.deepEqual(hintLeaks("blanks", blanks, ["It is in, not at."]), ["in"]);
		const numeric = { answer: "10", mode: "number" };
		assert.deepEqual(hintLeaks("numeric", numeric, ["there are 100 in total"]), []);
		assert.deepEqual(hintLeaks("numeric", numeric, ["it is 10."]), ["10"]);
		assert.deepEqual(hintLeaks("numeric", { answer: "x^2", mode: "expr" }, ["try (x^2)"]), ["x^2"]);
	});
});

describe("the answer record", () => {
	const blanksInput = {
		question: "Fill in",
		format: "blanks" as const,
		explanation: "because",
		spec: { text: "{{a}} and {{b}}", blanks: [{ id: "a", accept: ["cat"] }, { id: "b", accept: ["dog"] }] },
		hints: ["h1", "h2"],
	};

	it("buildExerciseAnswer grades and compacts", () => {
		const ad = buildExerciseAnswer(blanksInput, { values: { a: "cat", b: "x" } }, { attempts: 2, hintsUsed: 1, gaveUp: false, confidence: 70 }, "exercise", "tc");
		assert.equal(ad.kind, "exercise");
		assert.equal(ad.correct, false);
		assert.equal(ad.verdict?.items.find((i) => i.id === "b")?.expected, "dog", "the record keeps the key");
		const compact = compactAnswerForModel(ad);
		assert.equal(compact.outcome, "partly");
		assert.equal(compact.earned, 1);
		assert.equal(compact.total, 2);
		assert.equal(compact.attempts, 2);
		assert.equal(compact.hintsUsed, 1);
		assert.equal(compact.confidence, 70);
		assert.ok(!JSON.stringify(compact).includes("expected"), "no expected fields");
		assert.ok(!JSON.stringify(compact).includes("dog"));
	});

	it("keeps gaveUp and firstAttempt, and drops confidence on don't know", () => {
		const first = buildExerciseAnswer(blanksInput, { values: {} }, { attempts: 1, hintsUsed: 0, gaveUp: false }).verdict!;
		const ad = buildExerciseAnswer(blanksInput, { values: {} }, { attempts: 3, hintsUsed: 2, gaveUp: true, dontKnow: true, confidence: 90, firstAttempt: { verdict: first, confidence: 40 } });
		assert.equal(ad.confidence, undefined);
		const compact = compactAnswerForModel(ad) as Record<string, any>;
		assert.equal(compact.gaveUp, true);
		assert.equal(compact.dontKnow, true);
		assert.equal(compact.firstAttempt.outcome, "wrong");
		assert.equal(compact.firstAttempt.confidence, 40);
		assert.ok(!JSON.stringify(compact).includes("expected"));
	});

	it("parseExerciseInput accepts a posed call and refuses an ungradeable one", () => {
		const ok = parseExerciseInput(teachCall);
		assert.equal(ok.ok, true);
		assert.deepEqual(ok.ok && ok.input.spec, numericSpec, "the open spec survives the clean");
		assert.equal(parseExerciseInput({ ...teachCall, spec: { answer: "", mode: "number" } }).ok, false);
		assert.equal(parseExerciseInput({ ...teachCall, format: "bogus" }).ok, false);
		assert.equal(parseExerciseInput(null).ok, false);
	});

	it("exercise placeholder result is not persisted", () => {
		const chatId = newChat("placeholder");
		const call = {
			id: "m1",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "exercise", arguments: teachCall }],
			stopReason: "toolUse",
			timestamp: 1,
		} as unknown as LhMessage;
		const placeholder = {
			id: "m2",
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "exercise",
			content: [{ type: "text", text: "Question posed" }],
			isError: false,
			timestamp: 2,
		} as unknown as LhMessage;
		persistTurn(chatStore, chatId, 0, asAgentMessages([call, placeholder]), false);
		const saved = chatStore.getChat(chatId)!.messages;
		assert.deepEqual(saved.map((m) => (m as { role: string }).role), ["assistant"]);
	});
});

describe("practice problem format + spec", () => {
	const gate = { problemActive: false };
	const stmt = { statement: "s", mode: "recall", modelSolution: "m" };
	it("validates a carried spec and requires the pair", async () => {
		const { problemTool } = await import("../src/agent/tools/practice.ts");
		const tool = () => problemTool({ problemActive: false }, undefined, ["numeric"]);
		assert.equal((await run(tool(), { ...stmt, format: "numeric", spec: numericSpec })).ok, true);
		assert.match((await run(tool(), { ...stmt, format: "numeric", spec: { answer: "x", mode: "number" } })).problems.join(), /not a number/);
		assert.match((await run(tool(), { ...stmt, format: "numeric" })).problems.join(), /go together/);
		assert.match((await run(tool(), { ...stmt, format: "table", spec: {} })).problems.join(), /not enabled/);
		assert.equal((await run(tool(), stmt)).ok, true);
		void gate;
	});
});
