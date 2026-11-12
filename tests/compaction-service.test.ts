/**
 * THE COMPACTION SERVICE (owner round 14, 2026-10-05): the trigger
 * plumbing — settle kick + turn-start gate, the registry mutex, the
 * summary call, usage, events. Pinned here with an injected summarizer
 * (the sub-agent one-shot needs a live engine; the SERVICE laws don't).
 *
 * The laws:
 * - the registry is a mutex: concurrent ensureCompacted → ONE summary;
 * - over-threshold → marker inserted + usage logged + events emitted;
 * - under-threshold (or the projection post-marker) → no-op;
 * - chained compaction: the span carries the prior summary forward;
 * - the effective threshold: min(setting, window − reserve).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, type TestContext } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const {
	ensureCompacted,
	kickCompaction,
	awaitCompaction,
	compactionInFlight,
	effectiveThresholdTokens,
	projectedContextTokens,
} = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ToolCall } from "@earendil-works/pi-ai";
const { subscribe } = await import("../src/core/events.ts");
const { activeCompactionOf, newCompactionMarker, newUserMessage, measuredContextTokens, COMPACTED_HISTORY_HEADER, activeProblemOf, buildSubagentSteer, danglingQuestionOf, dismissedAnswer, endsInDismissal, newMessageId, toLlmMessages } = await import("../src/core/index.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
const artifactUiRoute = await import("../app/api/chats/[id]/artifact-ui/route.ts");
import type { LhMessage } from "../src/core/index.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

const big = (text: string, kb = 100): LhMessage => newUserMessage(`${text}: ${"x".repeat(kb * 1024)}`);

/** A chat whose record projects far over any test threshold. */
function overThresholdChat(label: string): string {
	const chat = chatStore.createChat(label);
	const messages = [big("m1"), big("m2"), big("m3"), newUserMessage("recent")];
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

let summarizeCalls = 0;
const depsOf = (chatId: string, thresholdTokens: number): CompactionDeps => ({
	chatStore,
	// The engine is never touched when summarize is injected (only its
	// identity rides the marker's provenance) — a minimal stand-in.
	engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
	modelId: "faux:test",
	kind: "teach",
	thresholdTokens,
	systemPromptTokens: 100,
	summarize: async (prompt) => {
		summarizeCalls++;
		assert.ok(prompt.includes("TRANSCRIPT") || prompt.length > 0);
		return {
			summary: `SUMMARY #${summarizeCalls}: the learner knows X.`,
			usage: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
	},
});

// ── the laws ────────────────────────────────────────────────────────────────

describe("the compaction service", () => {
	it("background eligibility skips both entrypoints without writes, but still awaits an existing structural run", async () => {
		const chatId = overThresholdChat("compact: consent off");
		const before = summarizeCalls;
		const denied = { ...depsOf(chatId, 40_000), canStart: () => false };
		await ensureCompacted(denied, chatId); kickCompaction(() => denied, chatId);
		assert.equal(summarizeCalls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const started = new Promise<void>((done) => { entered = done; });
		const allowed = { ...depsOf(chatId, 40_000), summarize: async (prompt: string) => { entered(); await gate; return depsOf(chatId, 40_000).summarize!(prompt, denied.engine); } };
		kickCompaction(() => allowed, chatId); await started;
		let finished = false;
		const waiter = ensureCompacted(denied, chatId).then(() => { finished = true; });
		await Promise.resolve(); assert.equal(finished, false);
		release(); await waiter; assert.equal(finished, true);
	});
	it("over-threshold record → marker inserted, usage logged, both events emitted", async () => {
		const chatId = overThresholdChat("compact: basic");
		const events: string[] = [];
		const off = subscribe((e) => {
			const { chatId: c, running } = e as { chatId?: string; running?: boolean };
			if (e.type === "compaction-changed" && c === chatId) events.push(`${running}`);
			if (e.type === "record-changed" && c === chatId) events.push("record");
		});
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		off();

		const record = chatStore.getChat(chatId)!;
		const marker = activeCompactionOf(record.messages);
		assert.ok(marker, "the marker landed");
		assert.ok(marker!.content.includes("SUMMARY #"));
		assert.ok(marker!.details.tokensBefore > 40_000, "provenance carries the trigger reading");
		assert.equal(marker!.details.model, "faux:test");
		// the projection now fits: the dropped span is gone from the wire view
		assert.ok(projectedContextTokens(record.messages, 100) < 40_000, "the cut brought the projection under threshold+summary");
		// usage landed on the money channel, keyed by the marker
		assert.ok((record.turns ?? []).some((t) => t.messageId === marker!.id && t.model === "faux:test"), "usage keyed by the marker");
		// events: running true → record-changed → running false
		assert.deepEqual(events, ["true", "record", "false"]);
	});

	it("under-threshold record → a no-op (no marker, no summary call)", async () => {
		const chatId = overThresholdChat("compact: under");
		const before = summarizeCalls;
		await ensureCompacted(depsOf(chatId, 10_000_000), chatId);
		assert.equal(summarizeCalls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
	});

	it("the registry is a mutex: concurrent ensureCompacted → ONE summary", async () => {
		const chatId = overThresholdChat("compact: mutex");
		const before = summarizeCalls;
		const deps = depsOf(chatId, 40_000);
		await Promise.all([ensureCompacted(deps, chatId), ensureCompacted(deps, chatId), ensureCompacted(deps, chatId)]);
		assert.equal(summarizeCalls, before + 1, "exactly one summary however many gates race");
	});

	it("awaitCompaction: a later call rides the in-flight one (the structural gate)", async () => {
		const chatId = overThresholdChat("compact: gate");
		const events: string[] = [];
		const off = subscribe((e) => {
			const { chatId: c, running } = e as { chatId?: string; running?: boolean };
			if (e.type === "compaction-changed" && c === chatId) events.push(`${running}`);
		});
		const p = ensureCompacted(depsOf(chatId, 40_000), chatId);
		await awaitCompaction(chatId); // rides the same promise
		await p;
		off();
		assert.deepEqual(events, ["true", "false"], "no second compaction started");
	});

	it("chained compaction: the span carries the PRIOR summary forward", async () => {
		const chatId = overThresholdChat("compact: chained");
		let seenPrompt = "";
		const deps: CompactionDeps = {
			...depsOf(chatId, 40_000),
			summarize: async (prompt) => {
				seenPrompt = prompt;
				return {
					summary: "SECOND SUMMARY.",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
		};
		// first compaction
		await ensureCompacted({ ...depsOf(chatId, 40_000) }, chatId);
		// grow the record past the threshold again (post-markers + new tail)
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, big("m9"), big("m10"), big("m11")]);
		// second compaction — the span must open with the FIRST summary
		await ensureCompacted(deps, chatId);
		assert.ok(seenPrompt.includes("prior compaction summary"), "the prior summary rides the span");
		assert.ok(seenPrompt.includes(COMPACTED_HISTORY_HEADER), "as the marker's canonical text");
		const record = chatStore.getChat(chatId)!;
		const markers = record.messages.filter((m) => (m as { customType?: string }).customType === "compaction");
		assert.equal(markers.length, 2, "both markers persist (history is never rewritten)");
		assert.ok(activeCompactionOf(record.messages)!.content.includes("SECOND SUMMARY"), "the newest rules");
	});

	it("a resolved prior summary replaces all summary markers in the newly superseded span", async () => {
		const chat = chatStore.createChat("summary span fixture");
		const kept = big("previously retained");
		const details = { firstKeptMessageId: kept.id, tokensBefore: 150_000, at: "fixture" };
		const steer: LhMessage = { id: "steer", role: "custom", customType: "subagent-steer", content: "RESEARCH DELIVERY", display: true, details: {}, timestamp: 1 };
		const messages = [big("discarded"), kept, newCompactionMarker("SUPERSEDED SUMMARY", details), steer, newCompactionMarker("LATEST SUMMARY", details), big("growth"), big("recent")];
		chatStore.saveMessages(chat.id, messages);
		let seenPrompt = "";
		await ensureCompacted({ ...depsOf(chat.id, 40_000), summarize: async (prompt, engine) => {
			seenPrompt = prompt;
			return depsOf(chat.id, 40_000).summarize!(prompt, engine);
		} }, chat.id);
		assert.ok(seenPrompt.includes("previously retained"));
		assert.ok(seenPrompt.includes("RESEARCH DELIVERY"), "non-compaction context markers still ride the span");
		assert.ok(!seenPrompt.includes("SUPERSEDED SUMMARY"));
		assert.equal(seenPrompt.split("LATEST SUMMARY").length - 1, 1);
		assert.equal(seenPrompt.split(COMPACTED_HISTORY_HEADER).length - 1, 1);
		assert.deepEqual(chatStore.getChat(chat.id)!.messages.slice(0, -1), messages);
	});

	it("the production summarizer rejects a length-stopped checkpoint and a complete retry can commit", async () => {
		const chatId = overThresholdChat("incomplete summary fixture");
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, big("growth 1"), big("growth 2")]);
		const faux = createFauxCore({});
		const { summarize: _injected, ...base } = depsOf(chatId, 40_000);
		const deps: CompactionDeps = { ...base, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
		const before = chatStore.getChat(chatId)!;
		assert.ok(activeCompactionOf(before.messages), "the failed replacement must preserve an existing checkpoint too");
		// NODE_ENV=test otherwise deliberately skips non-injected summaries.
		const env: Record<string, string | undefined> = process.env;
		const originalNodeEnv = env.NODE_ENV;
		env.NODE_ENV = "development";
		try {
			faux.setResponses([fauxAssistantMessage("INCOMPLETE SUMMARY", { stopReason: "length" })]);
			await ensureCompacted(deps, chatId);
			assert.deepEqual(chatStore.getChat(chatId), before, "an explicitly unfinished summary must not become a checkpoint");
			assert.equal(compactionInFlight(chatId), false, "the failed run releases its gate");
			faux.setResponses([fauxAssistantMessage("COMPLETE SUMMARY")]);
			await ensureCompacted(deps, chatId);
			const record = chatStore.getChat(chatId)!;
			assert.ok(activeCompactionOf(record.messages)!.content.includes("COMPLETE SUMMARY"));
			assert.ok(!JSON.stringify(record.messages).includes("INCOMPLETE SUMMARY"));
		} finally {
			if (originalNodeEnv === undefined) delete env.NODE_ENV;
			else env.NODE_ENV = originalNodeEnv;
		}
	});

	it("effectiveThresholdTokens: the setting rules big windows; the window rule binds small ones", () => {
		assert.equal(effectiveThresholdTokens(150_000, 200_000), 150_000);
		assert.equal(effectiveThresholdTokens(150_000, 100_000), 100_000 - 16_384);
		assert.equal(effectiveThresholdTokens(undefined, 200_000), 150_000);
		assert.equal(effectiveThresholdTokens(undefined, undefined), 150_000);
	});

	it("kickCompaction: fire-and-forget, registry-set, over-threshold only", async () => {
		const chatId = overThresholdChat("compact: kick");
		const before = summarizeCalls;
		let built = 0;
		kickCompaction(() => {
			built++;
			return depsOf(chatId, 40_000);
		}, chatId);
		assert.equal(built, 1, "deps built once");
		await awaitCompaction(chatId);
		assert.equal(summarizeCalls, before + 1);
		// beneath threshold now → a second kick builds its deps, the
		// pre-check refuses, and NO summary runs (building deps is the
		// kick's discovery step — the run is what costs)
		const afterFirst = summarizeCalls;
		kickCompaction(() => {
			built++;
			return depsOf(chatId, 40_000);
		}, chatId);
		assert.equal(summarizeCalls, afterFirst, "post-compaction record is under threshold — no run");
		// a null deps build (engineless) is a silent no-op
		kickCompaction(() => null, chatId);
	});

	it("a usage-heavy zero cut does not spend or append a marker", async () => {
		const chat = chatStore.createChat("no-progress fixture");
		const assistant = { id: "measured", role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 120_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 120_001 }, timestamp: 1 } as LhMessage;
		chatStore.saveMessages(chat.id, [newUserMessage("tiny visible history"), assistant]);
		const before = summarizeCalls;
		await ensureCompacted(depsOf(chat.id, 40_000), chat.id);
		assert.equal(summarizeCalls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chat.id)!.messages), null);
		assert.equal(measuredContextTokens(chatStore.getChat(chat.id)!.messages), 120_001);
	});

	it("starting/failing compaction preserves the meter; committing its marker clears it, regardless of summary usage", async () => {
		const id = overThresholdChat("meter validity fixture");
		const assistant = { id: "measured", role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 120_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 120_001 }, timestamp: 1 } as LhMessage;
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, assistant]);
		let release!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const deps = depsOf(id, 40_000);
		const running = ensureCompacted({ ...deps, summarize: async () => {
			await gate;
			throw new Error("fixture failure");
		} }, id);
		assert.equal(measuredContextTokens(chatStore.getChat(id)!.messages), 120_001);
		release(); await running;
		assert.equal(measuredContextTokens(chatStore.getChat(id)!.messages), 120_001);
		await ensureCompacted(deps, id);
		const record = chatStore.getChat(id)!;
		assert.ok(record.turns!.at(-1)!.steps[0]!.inputTokens! > 0);
		assert.equal(measuredContextTokens(record.messages), null);
	});

	it("a summarizer failure leaves the record untouched and the gate re-arms", async () => {
		const chatId = overThresholdChat("compact: fail");
		const before = summarizeCalls;
		const failing: CompactionDeps = {
			...depsOf(chatId, 40_000),
			summarize: async () => {
				throw new Error("boom");
			},
		};
		await ensureCompacted(failing, chatId);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null, "no marker on failure");
		// the next gate retries cleanly
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages));
		assert.equal(summarizeCalls, before + 1);
	});

	it("a message written during the summary call survives, after the marker", async () => {
		const chatId = overThresholdChat("compact: concurrent append");
		const deps = depsOf(chatId, 40_000);
		const late = newUserMessage("written while the summary ran");
		await ensureCompacted(
			{
				...deps,
				summarize: async (prompt, engine) => {
					const record = chatStore.getChat(chatId)!;
					chatStore.saveMessages(chatId, [...record.messages, late]);
					return deps.summarize!(prompt, engine);
				},
			},
			chatId,
		);
		const messages = chatStore.getChat(chatId)!.messages;
		assert.ok(messages.some((m) => m.id === late.id), "the concurrent write is kept");
		assert.ok(activeCompactionOf(messages), "the marker landed");
		assert.equal(messages.at(-1)!.id, late.id, "the concurrent write stays last, after the marker");
		assert.equal(messages.at(-2)!.id, activeCompactionOf(messages)!.id, "the marker sits right after the summarised snapshot");
	});

	it("a chat deleted during the summary call ends the compaction quietly", async () => {
		const chatId = overThresholdChat("compact: deleted meanwhile");
		const deps = depsOf(chatId, 40_000);
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...args: unknown[]) => void errors.push(args);
		try {
			await ensureCompacted(
				{
					...deps,
					summarize: async (prompt, engine) => {
						chatStore.deleteChat(chatId);
						return deps.summarize!(prompt, engine);
					},
				},
				chatId,
			);
		} finally {
			console.error = orig;
		}
		assert.deepEqual(errors, [], "a deleted chat is not a failed compaction");
		assert.equal(chatStore.getChat(chatId), null);
	});

	it("a summarised message changed during the summary call → no marker, no usage", async () => {
		const chatId = overThresholdChat("compact: concurrent edit");
		const deps = depsOf(chatId, 40_000);
		const edited = newUserMessage("rewritten while the summary ran");
		await ensureCompacted(
			{
				...deps,
				summarize: async (prompt, engine) => {
					const [, ...rest] = chatStore.getChat(chatId)!.messages;
					chatStore.saveMessages(chatId, [edited, ...rest]);
					return deps.summarize!(prompt, engine);
				},
			},
			chatId,
		);
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.messages[0]!.id, edited.id, "the concurrent write is kept");
		assert.equal(activeCompactionOf(record.messages), null, "a summary of text that changed is not checkpointed");
		assert.equal((record.turns ?? []).length, 0, "no usage for an abandoned compaction");
	});

	it("a summary call that never returns is aborted at the bound: nothing is checkpointed and waiting turns go on", async () => {
		const chatId = overThresholdChat("compact: hung summary");
		const before = JSON.stringify(chatStore.getChat(chatId));
		let seen: AbortSignal | undefined;
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...args: unknown[]) => void errors.push(args);
		try {
			kickCompaction(() => ({
				...depsOf(chatId, 40_000),
				summaryTimeoutMs: 20,
				summarize: (_prompt, _engine, signal) => {
					seen = signal;
					return new Promise(() => {}); // a provider stream that hangs
				},
			}), chatId);
			assert.equal(compactionInFlight(chatId), true);
			await awaitCompaction(chatId); // what every turn-start gate waits on
		} finally {
			console.error = orig;
		}
		assert.equal(compactionInFlight(chatId), false, "the gate is open again");
		assert.equal(seen?.aborted, true, "the summary call is aborted at the bound");
		assert.equal(JSON.stringify(chatStore.getChat(chatId)), before, "nothing is checkpointed");
		assert.equal(errors.length, 1, "logged once, as a failed compaction");
		assert.match(String(errors[0]![1]), /did not finish within 20 ms/);
		// The next gate retries on current truth, exactly as after a failure.
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages));
	});

	it("the production summarizer hands the bound's abort to the model request", async () => {
		const chatId = overThresholdChat("compact: hung provider");
		const before = JSON.stringify(chatStore.getChat(chatId));
		let seen: AbortSignal | undefined;
		const faux = createFauxCore({});
		faux.setResponses([
			((_context: unknown, options: { signal?: AbortSignal } | undefined) => {
				seen = options?.signal;
				return new Promise(() => {}); // never answers, never looks at the signal
			}) as never,
		]);
		const { summarize: _injected, ...base } = depsOf(chatId, 40_000);
		const deps: CompactionDeps = { ...base, summaryTimeoutMs: 20, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
		// NODE_ENV=test otherwise deliberately skips non-injected summaries.
		const env: Record<string, string | undefined> = process.env;
		const originalNodeEnv = env.NODE_ENV;
		env.NODE_ENV = "development";
		const orig = console.error;
		console.error = () => {};
		try {
			await ensureCompacted(deps, chatId);
		} finally {
			console.error = orig;
			if (originalNodeEnv === undefined) delete env.NODE_ENV;
			else env.NODE_ENV = originalNodeEnv;
		}
		assert.equal(seen?.aborted, true, "the provider request saw the abort");
		assert.equal(compactionInFlight(chatId), false);
		assert.equal(JSON.stringify(chatStore.getChat(chatId)), before, "nothing is checkpointed");
	});
});

// The marker sits where the summarised chat ended, so what the learner writes
// during the summary call stays AFTER it (the wake pipeline reads the last message).
describe("learner writes while compaction runs", () => {
	/** Over-threshold chat ending in `tail`, with a kicked compaction held
	 *  inside its summary call until `finish()`. */
	async function compactingChat(t: TestContext, label: string, ...tail: LhMessage[]) {
		const id = overThresholdChat(label);
		const original = [...chatStore.getChat(id)!.messages, ...tail];
		chatStore.saveMessages(id, original);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const started = new Promise<void>((done) => { entered = done; });
		const deps = depsOf(id, 40_000);
		t.after(async () => { release(); await awaitCompaction(id); });
		kickCompaction(() => ({
			...deps,
			summarize: async (prompt, engine) => { entered(); await gate; return deps.summarize!(prompt, engine); },
		}), id);
		await started;
		return { id, finish: async () => {
			const savedDuringSummary = chatStore.getChat(id)!.messages;
			assert.equal(compactionInFlight(id), true, "the write preceded summary completion");
			release();
			await awaitCompaction(id);
			const record = chatStore.getChat(id)!;
			const marker = activeCompactionOf(record.messages);
			assert.ok(marker, "compaction landed");
			assert.equal(record.messages[original.length]!.id, marker.id, "the marker sits right after the summarised snapshot");
			assert.deepEqual(record.messages.slice(0, original.length), savedDuringSummary.slice(0, original.length), "the snapshot and in-place edits survive");
			assert.deepEqual(record.messages.slice(original.length + 1), savedDuringSummary.slice(original.length), "everything written during the summary stays after the marker, in order");
			return record.messages;
		} };
	}
	const post = (route: { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }, id: string, input: unknown) =>
		route.POST(new Request(`http://test/api/chats/${id}`, { method: "POST", body: JSON.stringify(input) }), { params: Promise.resolve({ id }) });
	const toolCallMessage = (callId: string, name: string, args: ToolCall["arguments"]): LhMessage =>
		({ ...fauxAssistantMessage({ type: "toolCall", id: callId, name, arguments: args }), id: newMessageId() }) as LhMessage;
	const quiz = (callId: string) =>
		toolCallMessage(callId, "quiz", { question: "Q?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A is right." });

	it("a skip during compaction leaves the chat paused, same as a skip after it", async (t) => {
		const { id, finish } = await compactingChat(t, "marker: skip pause", quiz("q-pause"));
		const res = await post(dismissRoute, id, { input: { type: "dismiss", toolCallId: "q-pause", answer: dismissedAnswer("quiz", "Q?") } });
		assert.equal(res.status, 200);
		assert.equal(endsInDismissal(chatStore.getChat(id)!.messages), true, "paused before compaction commits");
		const messages = await finish();
		assert.equal(danglingQuestionOf(messages), null, "the skip survived compaction");
		assert.equal(endsInDismissal(messages), true, "job deliveries still hold until the learner speaks");
		// the wire view: the dismissal is live tail after the summary, never a kept-part start
		const wire = toLlmMessages(messages as never) as unknown as { role: string }[];
		assert.equal(wire[0]!.role, "user", "the kept part opens on the summary, not a tool result");
		assert.equal(wire.at(-1)!.role, "toolResult", "the dismissal reaches the model as the live tail");
	});

	it("a discarded practice problem stays discarded", async (t) => {
		const problem = toolCallMessage("p-marker", "problem", { statement: "Prove |G|=p => cyclic", mode: "recall" });
		const posed = { id: newMessageId(), role: "toolResult", toolCallId: "p-marker", toolName: "problem", content: [{ type: "text", text: "Problem posed." }], details: null, isError: false, timestamp: Date.now() } as LhMessage;
		const { id, finish } = await compactingChat(t, "marker: problem skip", problem, posed);
		const res = await post(dismissRoute, id, { input: { type: "dismiss-problem", problemCallId: "p-marker" } });
		assert.equal(res.status, 200);
		const messages = await finish();
		assert.equal(activeProblemOf(messages), null, "the discard survived compaction");
	});

	it("the invert switch on a message after the cut stays on", async (t) => {
		const steer = buildSubagentSteer({ id: "j-marker", kind: "demo", toolCallId: "c-marker" }, { title: "T", html: "<p>x</p>", tested: true });
		const { id, finish } = await compactingChat(t, "marker: invert", steer);
		const res = await post(artifactUiRoute, id, { input: { messageId: steer.id, inverted: true } });
		assert.equal(res.status, 200);
		const messages = await finish();
		const saved = messages.find((m) => m.id === steer.id) as unknown as { details: { ui?: { inverted?: boolean } } };
		assert.equal(saved.details.ui?.inverted, true, "the switch survived compaction");
	});

	it("no compaction starts while a turn is running for the chat; one starts after it settles", async () => {
		const chatId = overThresholdChat("marker: turn running");
		const before = summarizeCalls;
		assert.equal(beginTurn(chatId), true);
		try {
			await ensureCompacted(depsOf(chatId, 40_000), chatId);
			assert.equal(summarizeCalls, before, "the gate of a request arriving mid-turn does not summarise");
			assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
		} finally {
			endTurn(chatId);
		}
		kickCompaction(() => depsOf(chatId, 40_000), chatId); // the settle kick runs after endTurn
		await awaitCompaction(chatId);
		assert.equal(summarizeCalls, before + 1, "the settle kick is unaffected");
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages));
	});

	it("a second compaction over a record whose first marker sits mid-record summarises the in-between messages once", async (t) => {
		const { id, finish } = await compactingChat(t, "marker: chained", newUserMessage("seed"));
		const late = newUserMessage("LATE-WRITE written during the first summary");
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, late]);
		await finish();
		const afterFirst = chatStore.getChat(id)!.messages;
		const first = activeCompactionOf(afterFirst)!;
		assert.equal(afterFirst.at(-1)!.id, late.id, "the first marker sits mid-record, the write after it");
		chatStore.saveMessages(id, [...afterFirst, big("g1"), big("g2"), big("g3")]);
		let seenPrompt = "";
		const deps = depsOf(id, 40_000);
		await ensureCompacted({ ...deps, summarize: async (prompt, engine) => { seenPrompt = prompt; return deps.summarize!(prompt, engine); } }, id);
		assert.equal(seenPrompt.split("LATE-WRITE").length - 1, 1, "the in-between message is summarised once");
		assert.equal(seenPrompt.split(COMPACTED_HISTORY_HEADER).length - 1, 1, "the prior summary rides once");
		const messages = chatStore.getChat(id)!.messages;
		const second = activeCompactionOf(messages)!;
		assert.notEqual(second.id, first.id);
		assert.equal(messages.at(-1)!.id, second.id, "nothing was written meanwhile: the new marker closes the record");
		assert.equal(messages.indexOf(first as never) < messages.findIndex((m) => m.id === late.id), true, "the first marker keeps its place");
		const wire = JSON.stringify(toLlmMessages(messages as never));
		assert.ok(!wire.includes("LATE-WRITE"), "the summarised write is not in the wire view again");
		assert.ok(wire.includes("SUMMARY #"), "the newest summary heads the wire view");
	});
});
