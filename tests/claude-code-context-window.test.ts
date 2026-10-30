/**
 * Claude Code context-window probe (src/agent/claude-code/context-window.ts).
 *
 * Only the probe is ported here. Upstream's persistence and stats-bar half of
 * this file (cliContextWindowOf, contextLimitForModel, toModelDto) belongs to
 * the server and UI wiring, which this fork does not have yet.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ContextWindowProbe } from "../src/agent/claude-code/context-window.ts";

function setup() {
	const writes: { type: string; request_id: string; request: Record<string, string> }[] = [];
	const windows: number[] = [];
	let prompts = 0;
	const probe = new ContextWindowProbe((line) => writes.push(JSON.parse(line)), () => prompts++, (tokens) => windows.push(tokens));
	probe.start();
	const reply = (index: number, body: unknown, subtype = "success") => probe.handle({ type: "control_response", response: {
		request_id: writes[index]!.request_id, subtype, response: body,
	} });
	return { probe, writes, windows, reply, prompts: () => prompts };
}

test("control initialization precedes a summary-only query; neither needs user input or a model request", () => {
	const p = setup();
	assert.deepEqual(p.writes[0]!.request, { subtype: "initialize" }); assert.equal(p.prompts(), 0);
	p.reply(0, {});
	assert.deepEqual(p.writes[1]!.request, { subtype: "get_context_usage", detail: "summary" });
	assert.equal(p.prompts(), 1, "conversation does not wait for metadata");
	assert.notEqual(p.writes[0]!.request_id, p.writes[1]!.request_id);
	p.probe.handle({ type: "control_response", response: { request_id: "foreign", subtype: "success", response: { maxTokens: 999 } } });
	assert.deepEqual(p.windows, []);
	p.reply(1, { maxTokens: 200000, rawMaxTokens: 1000000 });
	assert.deepEqual(p.windows, [200000], "effective maxTokens, not an assumed nominal window");
	p.reply(0, {}); p.reply(1, { maxTokens: 1 });
	assert.equal(p.prompts(), 1); assert.deepEqual(p.windows, [200000]);
	p.probe.close();
});

test("metadata unavailable before first response can be queried again locally; stale/closed replies are ignored", () => {
	const p = setup(); p.reply(0, {}); p.reply(1, {}, "error");
	assert.equal(p.prompts(), 1); assert.deepEqual(p.windows, []);
	p.probe.refresh();
	assert.deepEqual(p.writes[2]!.request, { subtype: "get_context_usage", detail: "summary" });
	p.reply(1, { maxTokens: 1 }); assert.deepEqual(p.windows, []);
	p.reply(2, { maxTokens: 200000 }); assert.deepEqual(p.windows, [200000]);
	p.probe.refresh(); p.probe.close(); p.reply(3, { maxTokens: 999999 });
	assert.deepEqual(p.windows, [200000]); assert.equal(p.prompts(), 1);
});

for (const tokens of [null, undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "200000"]) test(`invalid summary budget ${tokens} remains unknown without failing the prompt`, () => {
	const p = setup(); p.reply(0, {}); p.reply(1, { maxTokens: tokens });
	assert.deepEqual(p.windows, []); assert.equal(p.prompts(), 1); p.probe.close();
});

test("initialization errors/timeouts fall back to ordinary prompt delivery; close cancels the timer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const error = setup(); error.reply(0, undefined, "error");
	assert.equal(error.prompts(), 1); assert.equal(error.writes.length, 1); error.probe.close();
	const timeout = setup(); t.mock.timers.tick(5000);
	assert.equal(timeout.prompts(), 1); assert.equal(timeout.writes.length, 1);
	timeout.reply(0, {}); assert.equal(timeout.writes.length, 1); timeout.probe.close();
	const closed = setup(); closed.probe.close(); t.mock.timers.tick(5000);
	assert.equal(closed.prompts(), 0);
});
