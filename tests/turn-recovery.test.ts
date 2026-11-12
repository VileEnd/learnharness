import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../src/core/ports.ts";
import { abortSettleGraceMs, runPiTurn } from "../src/server/pi/ui-stream.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import { newTurnNudge } from "../src/agent/turn-nudge.ts";

/** No engine or network: exercise the runner's awaited listener seam. */
function agentEndingWith(loopFailure?: Error): Agent {
	const listeners: Array<(event: never) => unknown> = [];
	return {
		state: { messages: [] },
		subscribe(listener: (event: never) => unknown) { listeners.push(listener); return () => {}; },
		async continue() {
			await Promise.resolve(); // let the view subscribe before the terminal
			if (loopFailure) throw loopFailure;
			for (const listener of listeners) await listener({ type: "agent_end", messages: [] } as never);
		},
		abort() {},
	} as unknown as Agent;
}

function wireFrames(wire: string): string[] {
	return wire.split("\n\n").filter(Boolean).map(frame => frame.slice("data: ".length));
}

describe("turn settlement recovery", () => {
	it("reports a failed canonical save before DONE and cleans up before reporting", async () => {
		const order: string[] = [];
		const handle = runPiTurn({
			agent: agentEndingWith(),
			onFinish() { order.push("save"); throw new Error("synthetic disk failure"); },
			onSettleFailure() { order.push("cleanup"); },
			onSettleError() { order.push("report"); return "The reply could not be saved."; },
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.deepEqual(order, ["save", "cleanup", "report"]);
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
		assert.ok(frames.at(-2)?.includes("The reply could not be saved."));
	});

	it("still reports settlement failure when cleanup itself throws", async () => {
		const handle = runPiTurn({
			agent: agentEndingWith(),
			onFinish() { throw new Error("synthetic save failure"); },
			onSettleFailure() { throw new Error("synthetic cleanup failure"); },
			onSettleError: () => "The reply could not be saved.",
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
	});

	it("does not replace an already reported loop failure with a second settlement error", async () => {
		let cleanups = 0;
		const handle = runPiTurn({
			agent: agentEndingWith(new Error("synthetic loop failure")),
			onError: () => "An error occurred.",
			onFinish() { throw new Error("synthetic save failure"); },
			onSettleFailure(error, reportedErrorText) {
				cleanups++;
				assert.match(String(error), /synthetic save failure/);
				assert.equal(reportedErrorText, "An error occurred.");
			},
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.equal(cleanups, 1);
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
		assert.equal(frames.at(-1), "[DONE]");
	});

	it("a healthy terminal follows persistence and emits no error", async () => {
		let saves = 0;
		const handle = runPiTurn({ agent: agentEndingWith(), onFinish() { saves++; } });
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.equal(saves, 1);
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.some(f => f.includes('"type":"error"')), false);
	});

	it("the settle reports how many views were attached when the turn ended", async () => {
		const watched: number[] = [];
		const handle = runPiTurn({ agent: agentEndingWith(), onFinish(_messages, _aborted, viewers) { watched.push(viewers); } });
		await new Response(handle.subscribe()).text();
		const unwatched: number[] = [];
		let done!: () => void;
		const settled = new Promise<void>((resolve) => (done = resolve));
		runPiTurn({ agent: agentEndingWith(), onFinish(_messages, _aborted, viewers) { unwatched.push(viewers); done(); } });
		await settled;
		assert.deepEqual(watched, [1], "one view was attached");
		assert.deepEqual(unwatched, [0], "nobody was watching");
	});

	it("a forced settle after an ignored abort composes with a failed save; the stuck run's late end and failure are dropped", async () => {
		// An agent whose abort() does nothing: the run ends only when the test says so.
		const listeners: Array<(event: never) => unknown> = [];
		let finishRun!: (failure?: Error) => void;
		const runEnds = new Promise<Error | undefined>((resolve) => (finishRun = resolve));
		let lateDone!: () => void;
		const late = new Promise<void>((resolve) => (lateDone = resolve));
		const agent = {
			state: { messages: [], pendingToolCalls: new Set() },
			subscribe(listener: (event: never) => unknown) { listeners.push(listener); return () => {}; },
			async continue() {
				const failure = await runEnds;
				try {
					for (const listener of listeners) await listener({ type: "agent_end", messages: [] } as never);
					if (failure) throw failure;
				} finally { lateDone(); }
			},
			abort() {},
		} as unknown as Agent;
		const grace = abortSettleGraceMs.current;
		abortSettleGraceMs.current = 10;
		const warn = console.warn, error = console.error;
		console.warn = () => {};
		console.error = () => {};
		let finishes = 0, cleanups = 0;
		try {
			const handle = runPiTurn({
				agent,
				onFinish(_messages, isAborted) { finishes++; assert.equal(isAborted, true); throw new Error("synthetic save failure"); },
				onSettleFailure() { cleanups++; },
				onSettleError: () => "The reply could not be saved.",
			});
			const wire = new Response(handle.subscribe()).text();
			handle.abort();
			const frames = wireFrames(await wire);
			assert.equal(finishes, 1);
			assert.equal(cleanups, 1, "the claim is released once, through the failure cleanup");
			assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
			assert.equal(frames.at(-1), "[DONE]");
			finishRun(new Error("synthetic late loop failure"));
			await late;
			await new Promise((resolve) => setImmediate(resolve)); // let the runner's loop catch run
			assert.equal(finishes, 1, "the late agent_end does not settle again");
			assert.equal(cleanups, 1);
		} finally {
			abortSettleGraceMs.current = grace;
			console.warn = warn;
			console.error = error;
		}
	});

	it("a forced settle records what an honoured abort would: aborted results for the stuck batch, the watched partial stamped aborted", async () => {
		const call = (id: string) => ({ type: "toolCall", id, name: "stuck", arguments: {} });
		const batch = { role: "assistant", content: [call("a"), call("b")], stopReason: "toolUse", timestamp: 1 };
		const earlier = { role: "assistant", content: [call("old")], stopReason: "toolUse", timestamp: 0 };
		const resultA = { role: "toolResult", toolCallId: "a", toolName: "stuck", content: [], isError: false, timestamp: 2 };
		const partial = { role: "assistant", content: [{ type: "text", text: "half a sent" }], stopReason: "stop", timestamp: 3 };
		const settleStuck = async (state: object) => {
			const agent = { state, subscribe() { return () => {}; }, continue: () => new Promise(() => {}), abort() {} } as unknown as Agent;
			let finished!: (messages: AgentMessage[]) => void;
			const settled = new Promise<AgentMessage[]>((resolve) => (finished = resolve));
			const handle = runPiTurn({ agent, onFinish(messages) { finished(messages); } });
			handle.abort();
			return settled;
		};
		const grace = abortSettleGraceMs.current;
		abortSettleGraceMs.current = 1;
		const warn = console.warn;
		console.warn = () => {};
		try {
			const tools = await settleStuck({ messages: [earlier, batch, resultA], pendingToolCalls: new Set(["b"]) });
			assert.deepEqual(tools.slice(0, 3), [earlier, batch, resultA], "the state is kept as it was");
			assert.equal(tools.length, 4, "one result added, none for the earlier turn's call");
			assert.deepEqual({ ...tools[3], timestamp: 0 }, { role: "toolResult", toolCallId: "b", toolName: "stuck", content: [{ type: "text", text: "Operation aborted" }], details: {}, isError: true, timestamp: 0 });

			const streamed = await settleStuck({ messages: [], pendingToolCalls: new Set(), streamingMessage: partial });
			assert.deepEqual(streamed, [{ ...partial, stopReason: "aborted" }], "the partial the views saw is kept, stamped aborted");
		} finally {
			abortSettleGraceMs.current = grace;
			console.warn = warn;
		}
	});

	it("a forced settle in a parallel batch keeps a finished call's real result and aborts only the stuck one", async () => {
		// pi's parallel shape: every call starts, "a" finishes (its end event
		// carries the result), "b" never settles, and the batch's result
		// messages are only built once all calls are done, so none exist yet.
		const listeners: Array<(event: never) => unknown> = [];
		const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
		const batch = { role: "assistant", content: [call("a", "plan_init"), call("b", "stuck")], stopReason: "toolUse", timestamp: 1 };
		const state = { messages: [] as unknown[], pendingToolCalls: new Set<string>() };
		let ran!: () => void;
		const finishedA = new Promise<void>((resolve) => (ran = resolve));
		const agent = {
			state,
			subscribe(listener: (event: never) => unknown) { listeners.push(listener); return () => {}; },
			async continue() {
				const emit = async (event: unknown) => { for (const listener of listeners) await listener(event as never); };
				await Promise.resolve();
				await emit({ type: "message_start", message: batch });
				state.messages.push(batch);
				await emit({ type: "message_end", message: batch });
				state.pendingToolCalls = new Set(["a", "b"]);
				await emit({ type: "tool_execution_start", toolCallId: "a", toolName: "plan_init", args: {} });
				await emit({ type: "tool_execution_start", toolCallId: "b", toolName: "stuck", args: {} });
				state.pendingToolCalls = new Set(["b"]);
				await emit({ type: "tool_execution_end", toolCallId: "a", toolName: "plan_init", result: { content: [{ type: "text", text: "Plan saved." }], details: { saved: true } }, isError: false, durationMs: 5 });
				ran();
				await new Promise(() => {}); // "b" ignores the abort
			},
			abort() {},
		} as unknown as Agent;
		const grace = abortSettleGraceMs.current;
		abortSettleGraceMs.current = 1;
		const warn = console.warn;
		console.warn = () => {};
		try {
			let finished!: (messages: AgentMessage[]) => void;
			const settled = new Promise<AgentMessage[]>((resolve) => (finished = resolve));
			// "a" collides with an id the record already holds, so it is reminted.
			const handle = runPiTurn({ agent, usedToolCallIds: new Set(["a"]), onFinish(messages) { finished(messages); } });
			await finishedA;
			handle.abort();
			const [assistant, resultA, resultB, ...rest] = (await settled) as unknown as Array<Record<string, unknown>>;
			assert.equal(rest.length, 0);
			const ids = (assistant!.content as Array<{ id: string }>).map((c) => c.id);
			assert.notEqual(ids[0], "a", "the colliding id is reminted");
			assert.deepEqual({ ...resultA, timestamp: 0 }, {
				role: "toolResult", toolCallId: ids[0], toolName: "plan_init",
				content: [{ type: "text", text: "Plan saved." }], details: { saved: true }, usage: undefined,
				isError: false, durationMs: 5, timestamp: 0,
			}, "the finished call keeps its real result, under the reminted id");
			assert.equal(resultB!.toolCallId, "b");
			assert.equal(resultB!.isError, true);
			assert.deepEqual(resultB!.content, [{ type: "text", text: "Operation aborted" }]);
		} finally {
			abortSettleGraceMs.current = grace;
			console.warn = warn;
		}
	});

	it("does not contain a canonical write failure as an empty successful persist", () => {
		const store = {
			getChat: () => ({ messages: [] }),
			saveMessages() { throw new Error("synthetic disk failure"); },
		} as unknown as ChatStore;
		const message = { role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], stopReason: "stop", timestamp: 1 } as AgentMessage;
		assert.throws(() => persistTurn(store, "fixture", 0, [message], false), /The reply could not be saved\./);
	});

	it("never persists the hidden turn-nudge re-prompt", () => {
		let saved: unknown[] = [];
		const store = {
			getChat: () => ({ messages: [] }),
			saveMessages(_id: string, messages: unknown[]) { saved = messages; },
		} as unknown as ChatStore;
		const reply = { role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], stopReason: "stop", timestamp: 1 } as AgentMessage;
		const nudge = newTurnNudge("Synthetic re-prompt");
		persistTurn(store, "fixture", 0, [reply, nudge as AgentMessage, reply], true);
		assert.equal(saved.length, 2);
		assert.ok(!JSON.stringify(saved).includes("Synthetic re-prompt"));
	});
});
