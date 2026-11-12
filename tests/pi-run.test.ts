/**
 * The shared sub-agent runner: a provider error without message text still
 * fails the run (a failed LLM stage checkpoints nothing), and a run whose
 * signal is already aborted never starts a model call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";

function engineOf(step: ReturnType<typeof fauxAssistantMessage>) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([step]);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, faux };
}

describe("runSubagent", () => {
	it("throws on a provider error that carries no message text", async () => {
		const { engine } = engineOf(fauxAssistantMessage([fauxText("partial")], { stopReason: "error" }));
		await assert.rejects(
			runSubagent([], { role: "researcher", engine, systemPrompt: "s", prompt: "go", maxTurns: 2 }),
			/Subagent provider error/,
		);
	});
	it("keeps a provider's own error text", async () => {
		const { engine } = engineOf(fauxAssistantMessage([], { stopReason: "error", errorMessage: "rate limited" }));
		await assert.rejects(
			runSubagent([], { role: "researcher", engine, systemPrompt: "s", prompt: "go", maxTurns: 2 }),
			/rate limited/,
		);
	});
	it("starts no model call when the signal is already aborted", async () => {
		const { engine, faux } = engineOf(fauxAssistantMessage([fauxText("never")]));
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(
			runSubagent([], { role: "researcher", engine, systemPrompt: "s", prompt: "go", maxTurns: 2, abortSignal: ac.signal }),
			{ name: "AbortError" },
		);
		assert.equal(faux.state.callCount, 0);
	});
});
