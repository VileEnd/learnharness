/** agent.formats: per-format toggles - resolution, write side, settings UI. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PR1_FORMATS } from "../src/core/exercise-core.ts";
import { enabledFormats, resolveSettings } from "../src/core/settings-resolution.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";

describe("agent.formats", () => {
	it("enabledFormats of empty settings is every implemented format", () => {
		assert.deepEqual(enabledFormats(resolveSettings(null)), [...PR1_FORMATS]);
	});
	it("a false key drops the format", () => {
		const eff = resolveSettings({ version: 1, agent: { formats: { table: false } } });
		assert.deepEqual(enabledFormats(eff), PR1_FORMATS.filter((f) => f !== "table"));
	});
	it("write side rejects unknown formats", () => {
		const r = parseAgentSettingsBody({ formats: { bogus: true } });
		assert.equal(r.ok, false);
		if (!r.ok) assert.ok(r.error.includes("bogus"));
		const ok = parseAgentSettingsBody({ formats: { numeric: false } });
		assert.ok(ok.ok && ok.settings.formats?.numeric === false);
	});
	it("composeFormats keeps other agent keys", async () => {
		const { composeFormats } = await import("../components/settings/agent-section.tsx");
		const next = composeFormats({ quizMechanic: "free", formats: { table: false } }, "numeric", false);
		assert.equal(next.quizMechanic, "free");
		assert.deepEqual(next.formats, { table: false, numeric: false });
	});
	it("renders a row per format", async () => {
		const { AgentSection } = await import("../components/settings/agent-section.tsx");
		const html = renderToStaticMarkup(
			<AgentSection agent={undefined} models={undefined} graph={undefined} compaction={undefined} documents={undefined} onCompactionChange={() => {}} onDocumentsChange={() => {}} onSectionChange={() => {}} onModelsChange={() => {}} />,
		);
		for (const f of PR1_FORMATS) assert.ok(html.includes(`data-testid="format-row-${f}"`), f);
	});
});
