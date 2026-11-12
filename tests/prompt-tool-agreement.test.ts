/**
 * The prompts and the tool descriptions are both read by the model, so they
 * must not say different things. Each test pins one statement on BOTH sides:
 * the prompt fragment and the tool description (or the code the fragment
 * describes). Field-name pins live in question-tools.test.ts; these pin the
 * behavioural claims.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { PATHS } from "../config.ts";
import { questionNeedsReveal } from "../src/core/question-core.ts";
import { listSourceSegments } from "../src/agent/prompt-segments.ts";
import { annotateInputObject } from "../src/agent/tools/annotate.ts";
import { concludeTool, createPracticeGate, practiceTools, problemTool } from "../src/agent/tools/practice.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { probeSketchToolFor, teachWorkToolFor } from "../src/agent/tools/work.ts";
import { IMPLEMENTED_FORMATS } from "../src/core/exercise-core.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const promptText = (rel: string) => fs.readFileSync(path.join(PATHS.root, "src/agent/prompts", rel), "utf-8");

describe("plan size: the plan_init description follows the planning prompt", () => {
	const description = planTools({ chatId: "chat_x", chatStore: undefined as never }).plan_init!.description;

	it("the prompt sets no size ceiling and says compression is not what keeps a map readable", () => {
		const prompt = promptText("teacher/10-planning.md");
		assert.ok(prompt.includes("No size ceiling"));
		assert.ok(prompt.includes("isn't compression"));
	});

	it("the tool description states no node count and does not tell the model to compress", () => {
		assert.doesNotMatch(description, /\d+\s*[–—-]\s*\d+\s*nodes/i, "no node-count range");
		assert.doesNotMatch(description, /compress/i);
		assert.match(description, /a map, not a syllabus/i, "still says what the prompt says: a map");
	});
});

describe("the collapse law: the teaching prompt says what questionNeedsReveal does", () => {
	it("code: only quiz, explain, exercise and work collapse behind the reveal; ask_user_question arrives open", () => {
		for (const tool of ["quiz", "explain", "exercise", "work"]) {
			assert.equal(questionNeedsReveal(tool, { type: "check" }, "teach"), true, tool);
		}
		assert.equal(questionNeedsReveal("ask_user_question", {}, "teach"), false);
	});

	it("prompt: the collapse-law sentence about ask_user_question says it does not apply", () => {
		const prompt = promptText("teacher/20-teaching.md");
		const sentence = prompt.split("\n").find((line) => line.includes("collapse law") && line.includes("ask_user_question"));
		assert.ok(sentence, "the prompt still addresses ask_user_question under the collapse law");
		assert.match(sentence, /does not apply to `ask_user_question`/);
		assert.doesNotMatch(sentence, /arrives behind the button/);
	});
});

// ── the canvas section, per role ─────────────────────────────────────────────
// The canvas fragments are composed for more than one agent, and each agent
// holds a different set of tools. A fragment must name only what the reader
// of THIS composition has, so the check is: every backticked name in the
// canvas fragments a role composes is one of that role's tools, one of those
// tools' fields, or a drawing id / grid cell.

const CANVAS_FRAGMENTS = ["shared/24-canvas-tools.md", "shared/24-drawings.md"];
const drawingStore = { getScene: () => null } as never;
const stubCtx = { chatId: "chat_x", chatStore: { getChat: () => null } as never, drawingStore, canvas: true, libraryRoot: "/nonexistent-library" };

const toolNames = (registry: Record<string, { parameters?: unknown }>) => {
	const names = new Set(Object.keys(registry));
	for (const tool of Object.values(registry)) {
		const props = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
		for (const field of Object.keys(props ?? {})) names.add(field);
	}
	return names;
};
const ANNOTATE_NAMES = ["drawingId", "marks", "kind", "target", "from", "to", "label", "object", "stroke", "cell", "cells"];
const DRAWING_REFS = /^(?:[os]\d+|[A-H]\d+(?:[-:][A-H]\d+)?)$/;

/** The backticked names of the canvas fragments one role composes. */
function canvasCitations(role: "teacher" | "prober" | "practice"): string[] {
	const composed = new Set(listSourceSegments(role).map((segment) => segment.path));
	const cited: string[] = [];
	for (const fragment of CANVAS_FRAGMENTS) {
		if (!composed.has(fragment)) continue;
		cited.push(...Array.from(promptText(fragment).matchAll(/`([A-Za-z_0-9:-]+)`/g), (m) => m[1]!));
	}
	return cited;
}

describe("the canvas section reaches practice, and names only what practice holds", () => {
	const practice = toolNames(practiceTools(stubCtx));

	it("the practice prompt tells the agent to read a drawing as the canvas tool section describes", () => {
		assert.match(promptText("practice/00-base.md"), /as the canvas tool section describes/);
	});

	it("the practice composition contains that section", () => {
		assert.ok(listSourceSegments("practice").some((segment) => segment.path === "shared/24-drawings.md"));
		const composed = composeInstructions("practice");
		assert.ok(composed.includes("### Reading a drawing"));
		assert.ok(composed.includes("### Marking a drawing"));
	});

	it("every name the practice composition cites from the canvas section is a practice tool or field", () => {
		const cited = canvasCitations("practice");
		assert.ok(cited.length >= 3, "the section cites names");
		const allowed = new Set([...practice, ...ANNOTATE_NAMES, ...Object.keys(annotateInputObject.properties)]);
		for (const name of cited) assert.ok(allowed.has(name) || DRAWING_REFS.test(name), `\`${name}\` is not something practice holds`);
	});

	it("the task mechanics (grade, side questions) stay out of practice's composition", () => {
		const composed = composeInstructions("practice");
		assert.ok(!composed.includes("Close the task with `grade`"));
		assert.ok(!composed.includes("Side questions"));
	});
});

describe("the canvas section names only what the prober holds", () => {
	const proberCtx = { ...stubCtx, jobStore: {} as never, spawn: () => {}, formats: IMPLEMENTED_FORMATS };
	const prober = toolNames(createProberTools(proberCtx as never));
	const teacher = toolNames(createTeacherTools(proberCtx as never));

	it("the prober holds probe, recall and assess, and none of the teacher's question tools or the `type` field", () => {
		for (const name of ["probe", "recall", "assess", "sketch", "grade", "annotate"]) assert.ok(prober.has(name), name);
		for (const name of ["quiz", "explain", "exercise", "work", "type"]) assert.ok(!prober.has(name), name);
	});

	it("every name the prober composition cites from the canvas section is a prober tool or field", () => {
		const cited = canvasCitations("prober");
		assert.ok(cited.length >= 3, "the section cites names");
		const allowed = new Set([...prober, ...ANNOTATE_NAMES, "20-question-tools"]);
		for (const name of cited) assert.ok(allowed.has(name) || DRAWING_REFS.test(name), `\`${name}\` is not something the prober holds`);
	});

	it("no teacher-only question tool is named in the canvas section the prober composes", () => {
		// "the exercise tool(s)" and "a quiz" are plain nouns (the tool's role, as 22-exercise-tools
		// calls it), not the teacher's tool names; a bare `quiz`, `explain` or `exercise` list is.
		const prose = CANVAS_FRAGMENTS.map(promptText).join("\n").replace(/exercise tools?/g, "").replaceAll("a quiz", "");
		assert.doesNotMatch(prose, /\b(quiz|explain|exercise)\b/i);
	});

	it("the teacher keeps its instruction: a canvas task posed before the teaching carries `type` predict", () => {
		assert.ok(teacher.has("type"));
		const composed = composeInstructions("teacher").replace(/\s+/g, " ");
		assert.ok(composed.includes("posed with `type` predict"));
		assert.ok(composed.includes("Teaching the answer and then posing the task as a check turns it into a copy exercise."));
		assert.ok(!composeInstructions("prober").includes("`type` predict"));
	});

	it("the open-task refusal names no tool the caller lacks (work for the teacher, sketch for the prober)", async () => {
		const record = {
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "call_w1", name: "work", arguments: {} }] },
				{ role: "toolResult", toolCallId: "call_w1", toolName: "work", content: [{ type: "text", text: "posed" }], isError: false },
			],
		};
		const ctx = { chatId: "chat_x", chatStore: { getChat: () => record } as never };
		const input = { question: "Sketch y = x^2.", correctAnswer: "A parabola through the origin.", requireThinking: false };
		for (const [role, tool, own] of [
			["teacher", teachWorkToolFor(ctx), teacher],
			["prober", probeSketchToolFor(ctx), prober],
		] as const) {
			const result = await tool.execute("call_w2", { ...input, type: "check", nodeId: "n1" } as never);
			assert.equal(result.isError, true, role);
			const refusal = (result.details as { problems: string[] }).problems.find((p) => p.includes("already open")) ?? "";
			assert.ok(refusal, `${role}: the refusal is there`);
			for (const word of ["quiz", "explain", "exercise"]) {
				if (!own.has(word)) assert.doesNotMatch(refusal.replace(/exercise tools?/g, ""), new RegExp(`\\b${word}\\b`, "i"), `${role}: the refusal names \`${word}\`, which it does not hold`);
			}
		}
	});
});

describe("the pause before the next practice problem: prompt, tool description and gate agree", () => {
	const concluded = { outcome: "solved", verdict: "ok", rung: null, missClass: null, retest: false };
	const pose = { statement: "State the rule.", mode: "recall", modelSolution: "The rule." };
	const active = [
		{ role: "assistant", content: [{ type: "toolCall", id: "call_p1", name: "problem", arguments: pose }] },
		{ role: "toolResult", toolCallId: "call_p1", toolName: "problem", content: [{ type: "text", text: "posed" }], isError: false },
	];
	const ctx = { chatId: "chat_x", chatStore: { getChat: () => ({ messages: active, kind: "practice" }) } as never, libraryRoot: "/nonexistent-library" };

	it("the prompt and the conclude description both say the next problem is not posed in the concluding reply", () => {
		const prompt = composeInstructions("practice").replace(/\s+/g, " ");
		assert.match(prompt, /no further tool calls in that reply, never another problem/);
		const description = concludeTool(createPracticeGate(ctx)).description;
		assert.match(description, /The next problem is NEVER posed here/);
	});

	it("the gate agrees: problem is refused after conclude in the same turn", async () => {
		const gate = createPracticeGate(ctx);
		assert.equal((await concludeTool(gate).execute("call_c1", concluded as never)).isError, undefined);
		const refused = await problemTool(gate).execute("call_p2", pose as never);
		assert.equal(refused.isError, true);
	});
});
