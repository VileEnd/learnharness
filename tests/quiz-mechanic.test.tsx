/**
 * The Mixed quizzing mechanic: resolution, tool registration, the write side
 * and the segmented control.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createProberTools, createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { resolveQuizMechanic } from "../src/core/settings-resolution.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";

const ctx: TeacherToolContext = {
	chatId: "quiz-mechanic-none",
	chatStore,
	jobStore,
	spawn: () => {},
	libraryRoot: "/nonexistent-library",
};
const proberCtx = { ...ctx, deliver: () => {} };

describe("resolveQuizMechanic", () => {
	it("absent mechanic resolves to mixed", () => {
		assert.equal(resolveQuizMechanic(undefined), "mixed");
		assert.equal(resolveQuizMechanic({}), "mixed");
	});
	it("explicit choice survives the Mixed default", () => {
		assert.equal(resolveQuizMechanic({ tools: { explain: false } }), "choice");
	});
	it("explain true resolves to free", () => {
		assert.equal(resolveQuizMechanic({ tools: { explain: true } }), "free");
	});
	it("an explicit quizMechanic wins over tools.explain", () => {
		assert.equal(resolveQuizMechanic({ quizMechanic: "mixed", tools: { explain: false } }), "mixed");
	});
});

describe("tool registration", () => {
	it("mixed registers quiz and explain for the teacher", () => {
		const keys = Object.keys(createTeacherTools({ ...ctx, quizMechanic: "mixed" }));
		assert.ok(keys.includes("quiz") && keys.includes("explain"));
	});
	it("mixed registers probe and recall for the prober", () => {
		const keys = Object.keys(createProberTools({ ...proberCtx, quizMechanic: "mixed" }));
		assert.ok(keys.includes("probe") && keys.includes("recall"));
	});
	it("grade armed in mixed", () => {
		assert.ok("grade" in createTeacherTools({ ...ctx, quizMechanic: "mixed" }));
		assert.ok("grade" in createProberTools({ ...proberCtx, quizMechanic: "mixed" }));
	});
	it("choice stays quiz-only and free stays explain-only", () => {
		const choice = Object.keys(createTeacherTools({ ...ctx, quizMechanic: "choice" }));
		assert.ok(choice.includes("quiz") && !choice.includes("explain") && !choice.includes("grade"));
		const free = Object.keys(createTeacherTools({ ...ctx, quizMechanic: "free" }));
		assert.ok(!free.includes("quiz") && free.includes("explain") && free.includes("grade"));
	});
});

describe("parseAgentSettingsBody quizMechanic", () => {
	it("accepts the three mechanics", () => {
		for (const m of ["mixed", "choice", "free"]) {
			const r = parseAgentSettingsBody({ quizMechanic: m });
			assert.ok(r.ok && r.settings.quizMechanic === m);
		}
	});
	it("rejects an unknown mechanic", () => {
		assert.equal(parseAgentSettingsBody({ quizMechanic: "both" }).ok, false);
		assert.equal(parseAgentSettingsBody({ quizMechanic: 3 }).ok, false);
	});
});

describe("segmented control", () => {
	it("renders Mixed first", async () => {
		const { AgentSection } = await import("../components/settings/agent-section.tsx");
		const html = renderToStaticMarkup(
			<AgentSection agent={undefined} models={undefined} graph={undefined} compaction={undefined} documents={undefined} onCompactionChange={() => {}} onDocumentsChange={() => {}} onSectionChange={() => {}} onModelsChange={() => {}} />,
		);
		const mixed = html.indexOf("quiz-mechanics-mixed");
		assert.ok(mixed > 0, "mixed segment rendered");
		assert.ok(mixed < html.indexOf("quiz-mechanics-choice"));
		const tag = html.slice(html.lastIndexOf("<", mixed), html.indexOf(">", mixed));
		assert.ok(tag.includes('aria-checked="true"'), "default is Mixed");
		assert.ok(html.indexOf("quiz-mechanics-choice") < html.indexOf("quiz-mechanics-free"));
	});
});
