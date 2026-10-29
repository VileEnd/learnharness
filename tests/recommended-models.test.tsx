import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { recommendedFor } from "../src/core/recommended-models.ts";
import { ModelMenuList, modelMenuRows } from "../components/settings/model-menu";

const m = (provider: string, id: string) => ({
	provider,
	id,
	name: id,
	cost: { input: 1, output: 2 },
	contextWindow: 1000,
	supportedLevels: [],
});

describe("recommendedFor", () => {
	it("falls back to the openrouter form", () => {
		const r = recommendedFor([m("openrouter", "anthropic/claude-opus-5.5")]);
		assert.equal(r.length, 1);
		assert.equal(r[0]!.model.provider, "openrouter");
	});
	it("prefers the anthropic form", () => {
		const r = recommendedFor([m("openrouter", "anthropic/claude-opus-5.5"), m("anthropic", "claude-opus-5-5")]);
		assert.equal(r[0]!.model.provider, "anthropic");
	});
	it("skips missing entries, keeping table order", () => {
		const r = recommendedFor([
			m("openrouter", "deepseek/deepseek-v4.1-flash"),
			m("anthropic", "claude-sonnet-5-5"),
			m("anthropic", "claude-opus-5-5"),
		]);
		assert.deepEqual(r.map((x) => x.entry.key), ["opus", "sonnet", "deepseek-flash"]);
	});
	it("is empty with no models", () => {
		assert.deepEqual(recommendedFor([]), []);
	});
});

describe("ModelMenuList recommended group", () => {
	const models = [m("openrouter", "xiaomi/mimo-v2.6-flash"), m("openrouter", "z-ai/glm-5")] as never;
	it("renders header and MiMo row for an empty query", () => {
		const html = renderToStaticMarkup(
			<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} recommended />,
		);
		assert.match(html, /Recommended/);
		assert.match(html, /TutorBench #1/);
		assert.match(html, /model-option-rec-mimo-flash/);
	});
	it("has no group rows when a query is typed", () => {
		assert.equal(modelMenuRows(models, "glm", true).group.length, 0);
		assert.equal(modelMenuRows(models, "", true).group.length, 1);
		assert.equal(modelMenuRows(models, "", false).group.length, 0);
	});
});
