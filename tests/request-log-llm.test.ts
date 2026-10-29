/** The request log's LLM side: every streamFn call through piEngineForSpec writes one line (cost counter, Task 2). */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { fauxAssistantMessage, fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import type { RequestLogLine } from "../src/core/contracts/usage.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { setRequestSink } from "../src/agent/request-log.ts";
import { withEmptyErrorRetry } from "../src/agent/turn-nudge.ts";

const SECRET = "the learner's private prompt text";
const faux = fauxProvider({ provider: "faux-request-log" });
piModels().setProvider(faux.provider);
const spec = { provider: faux.getModel().provider, id: faux.getModel().id };
const context = normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: SECRET, timestamp: Date.now() }] });

let lines: RequestLogLine[] = [];
const collect = () => {
	lines = [];
	setRequestSink((line) => lines.push(line));
};
afterEach(() => setRequestSink(null));

const teacher = () => piEngineForSpec(spec, { purpose: "teacher", chatId: "c1", chatKind: "teach" });
const errorReply = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

describe("observed engines write one request-log line per call", () => {
	it("ok: purpose, chat, category and the reply's usage", async () => {
		collect();
		faux.setResponses([fauxAssistantMessage("hello there")]);
		const engine = teacher();
		const message = await engine.streamFn(engine.model, context).result();
		assert.equal(lines.length, 1);
		const [line] = lines;
		assert.equal(line!.outcome, "ok");
		assert.equal(line!.purpose, "teacher");
		assert.equal(line!.chatId, "c1");
		assert.equal(line!.category, "teaching");
		assert.equal(line!.input, message.usage.input);
		assert.equal(line!.output, message.usage.output);
		assert.ok(line!.durationMs! >= 0);
	});

	it("a clock that steps back never gives a negative duration", async () => {
		collect();
		faux.setResponses([fauxAssistantMessage("hello")]);
		const engine = teacher();
		// The clock steps back 624 ms between the request and its end.
		const start = Date.now();
		let stepped = false;
		mock.method(Date, "now", () => (stepped ? start - 624 : start));
		try {
			const stream = engine.streamFn(engine.model, context);
			stepped = true;
			await stream.result();
		} finally {
			mock.restoreAll();
		}
		assert.equal(lines[0]!.durationMs, 0);
	});

	it("error: the line carries the error text", async () => {
		collect();
		faux.setResponses([errorReply("upstream exploded")]);
		const engine = teacher();
		await engine.streamFn(engine.model, context).result();
		assert.equal(lines[0]!.outcome, "error");
		assert.match(lines[0]!.error ?? "", /upstream exploded/);
	});

	it("aborted", async () => {
		collect();
		faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })]);
		const engine = teacher();
		await engine.streamFn(engine.model, context).result();
		assert.equal(lines[0]!.outcome, "aborted");
	});

	it("an engine with no purpose logs as unlabelled", async () => {
		collect();
		faux.setResponses([fauxAssistantMessage("hi")]);
		const engine = piEngineForSpec(spec);
		await engine.streamFn(engine.model, context).result();
		assert.equal(lines[0]!.purpose, "unlabelled");
	});

	it("the empty-error retry logs both attempts", async () => {
		collect();
		faux.setResponses([{ ...errorReply("The operation was aborted"), content: [] }, fauxAssistantMessage("second time lucky")]);
		const engine = teacher();
		const stream = await withEmptyErrorRetry(engine.streamFn)(engine.model, context);
		await stream.result();
		assert.deepEqual(lines.map((l) => l.outcome), ["error", "ok"]);
	});

	it("a throwing sink never breaks the stream", async () => {
		setRequestSink(() => {
			throw new Error("disk full");
		});
		faux.setResponses([fauxAssistantMessage("still here")]);
		const engine = teacher();
		const stream = engine.streamFn(engine.model, context);
		const events: string[] = [];
		for await (const e of stream) events.push(e.type);
		assert.equal(events.at(-1), "done");
		assert.equal((await stream.result()).stopReason, "stop");
	});

	it("the line holds no prompt or answer text", async () => {
		collect();
		faux.setResponses([fauxAssistantMessage("an answer")]);
		const engine = teacher();
		await engine.streamFn(engine.model, context).result();
		const json = JSON.stringify(lines[0]);
		assert.ok(!json.includes(SECRET));
		assert.ok(!json.includes("an answer"));
	});
});
