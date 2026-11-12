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
import { planTools } from "../src/agent/tools/plan.ts";

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
