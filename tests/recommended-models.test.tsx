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

describe("modelMenuRows index alignment", () => {
	it("list rows are offset by group.length in the walk", () => {
		const models = [m("openrouter", "xiaomi/mimo-v2.6-flash"), m("openrouter", "z-ai/glm-5")] as never;
		const { group, list } = modelMenuRows(models, "", true);
		const walk = [...group.map((g) => g.model), ...list];
		assert.equal(group.length, 1);
		assert.equal(walk[group.length], list[0]);
		assert.equal(walk.length, group.length + list.length);
	});
});

describe("ModelMenuList after the SearchMenuList extraction", () => {
	const models = [m("openrouter", "xiaomi/mimo-v2.6-flash"), m("openrouter", "z-ai/glm-5")] as never;
	it("renders the search box, the Recommended group above the list, and every catalog row", () => {
		const html = renderToStaticMarkup(
			<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} recommended />,
		);
		assert.match(html, /data-testid="model-search"/);
		assert.match(html, /data-testid="model-list"/);
		assert.ok(html.indexOf("model-group-recommended") < html.indexOf("model-option-z-ai_glm-5"));
		assert.match(html, /model-option-rec-mimo-flash/);
		assert.match(html, /model-option-z-ai_glm-5/);
	});
	it("shows only the catalog it is given (a policy-filtered catalog stays filtered)", () => {
		const html = renderToStaticMarkup(
			<ModelMenuList models={[m("openrouter", "z-ai/glm-5")] as never} effectiveId={undefined} onPick={() => {}} recommended />,
		);
		assert.doesNotMatch(html, /model-group-recommended/);
		assert.doesNotMatch(html, /mimo/);
		assert.match(html, /model-option-z-ai_glm-5/);
	});
	it("has no Recommended group unless asked, and shows the loading state while the catalog loads", () => {
		assert.doesNotMatch(renderToStaticMarkup(<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} />), /Recommended/);
		assert.match(renderToStaticMarkup(<ModelMenuList models={undefined} effectiveId={undefined} onPick={() => {}} />), /Loading models/);
	});
});
