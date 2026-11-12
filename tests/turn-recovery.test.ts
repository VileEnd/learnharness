import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../src/core/ports.ts";
import { abortSettleGraceMs, runPiTurn } from "../src/server/pi/ui-stream.ts";
import { persistTurn } from "../src/server/turn-service.ts";

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
			state: { messages: [] },
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

	it("does not contain a canonical write failure as an empty successful persist", () => {
		const store = {
			getChat: () => ({ messages: [] }),
			saveMessages() { throw new Error("synthetic disk failure"); },
		} as unknown as ChatStore;
		const message = { role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], stopReason: "stop", timestamp: 1 } as AgentMessage;
		assert.throws(() => persistTurn(store, "fixture", 0, [message], false), /The reply could not be saved\./);
	});
});
