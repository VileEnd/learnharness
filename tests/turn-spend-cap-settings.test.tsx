/** The Settings -> Agent "Max spend per turn (USD)" field. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

describe("turn spend cap field", () => {
	const noop = () => {};
	const render = async (agent?: object) => {
		const { AgentSection } = await import("../components/settings/agent-section.tsx");
		return renderToStaticMarkup(
			<AgentSection agent={agent} models={undefined} graph={undefined} compaction={undefined} documents={undefined} onCompactionChange={noop} onDocumentsChange={noop} onSectionChange={noop} onModelsChange={noop} />,
		);
	};
	it("renders the labelled number input with the default as placeholder", async () => {
		const html = await render();
		assert.ok(html.includes('data-testid="turn-spend-cap-row"'));
		assert.ok(html.includes("Max spend per turn (USD)"));
		assert.match(html, /data-testid="input-turn-spend-cap"[^>]*|placeholder="0.50"/);
		assert.ok(html.includes('placeholder="0.50"'));
	});
	it("shows a stored value", async () => {
		const html = await render({ turnSpendCapUsd: 2 });
		assert.ok(html.includes('value="2"'));
	});
	it("composeTurnSpendCap: empty unsets, junk is a no-op, range clamps", async () => {
		const { composeTurnSpendCap } = await import("../components/settings/agent-section.tsx");
		assert.equal(composeTurnSpendCap({ turnSpendCapUsd: 2, quizMechanic: "free" }, "").turnSpendCapUsd, undefined);
		assert.equal(composeTurnSpendCap({ turnSpendCapUsd: 2 }, "abc").turnSpendCapUsd, 2);
		assert.equal(composeTurnSpendCap({}, "0.01").turnSpendCapUsd, 0.05);
		assert.equal(composeTurnSpendCap({}, "99").turnSpendCapUsd, 20);
		assert.equal(composeTurnSpendCap({ quizMechanic: "free" }, "1.5").quizMechanic, "free");
	});
});
