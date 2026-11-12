/**
 * The extraction budgets reach the server's pipeline and document reader
 * (audit B4 review): `extractionBudgets` reads the effective settings fresh on
 * every call, and it is what chat-handler and library wire in, so a changed
 * Settings value changes the batch size the next run cuts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { extractionBudgets, stores } from "../src/server/stores.ts";
import { memoryGraphStore } from "./memory-graph-store.ts";

/** An engine that answers every call with one submit, counting the calls. */
function submitting(tool: string, input: unknown, count: { n: number }): PiEngine {
	const faux = createFauxCore({});
	const step: FauxResponseStep = () => {
		count.n++;
		return fauxAssistantMessage([fauxToolCall(tool, input as ToolCall["arguments"], { id: `${tool}-${count.n}` })], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 20 }, () => step));
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** How many chunks the pipeline cuts a ~1,500-token notes file into. */
async function chunksCut(): Promise<number> {
	const extracts = { n: 0 };
	const pipeline = createExtractionPipeline({
		chatStore: stores.chatStore,
		graphStore: memoryGraphStore(),
		extractor: submitting("submit_findings", { propositions: [], chains: [] }, extracts),
		auditor: submitting("submit_review", { links: [] }, { n: 0 }),
		getChunkTokens: extractionBudgets.chunkTokens,
	});
	const text = Array.from({ length: 60 }, (_, i) => `Line ${i}: ${"a few words of notes ".repeat(4)}`).join("\n");
	await pipeline.importNotes({ filePath: "/vault/budget.md", text });
	return extracts.n;
}

describe("the extraction budgets follow Settings", () => {
	it("a changed chunk budget changes the batch size the pipeline cuts", async () => {
		stores.settingsStore.writeSettings({ version: 1, graph: { extractionChunkTokens: 500 } });
		assert.equal(extractionBudgets.chunkTokens(), 500);
		const small = await chunksCut();
		stores.settingsStore.writeSettings({ version: 1, graph: { extractionChunkTokens: 100_000 } });
		assert.equal(extractionBudgets.chunkTokens(), 100_000);
		const large = await chunksCut();
		assert.equal(large, 1, "one chunk under the large budget");
		assert.ok(small > 1, `several chunks under the small budget (${small})`);
	});

	it("the digest budget is read the same way", () => {
		stores.settingsStore.writeSettings({ version: 1, graph: { extractionDigestTokens: 6000 } });
		assert.equal(extractionBudgets.digestTokens(), 6000);
		stores.settingsStore.writeSettings({ version: 1 });
		assert.equal(extractionBudgets.digestTokens(), 8000, "unset resolves the factory value");
	});
});
