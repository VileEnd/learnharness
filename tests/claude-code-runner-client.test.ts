/**
 * The Claude Code runner client (src/agent/claude-code/runner-client.ts):
 * the stream function drives a real runner (deploy/claude/runner.mjs) over
 * TCP, and the runner spawns tests/fixtures/claude-code/fake-claude.mjs, which
 * calls the app's MCP tool bridge back the way the CLI does.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, SimpleStreamOptions, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { createRunner } from "../deploy/claude/runner.mjs";
import { CLAUDE_CODE_NOT_SIGNED_IN_COPY, CLAUDE_CODE_UNREACHABLE_COPY } from "../src/agent/claude-code/constants.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createRunnerClient, runnerStatus } from "../src/agent/claude-code/runner-client.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude-code/", import.meta.url));
const FAKE_CLAUDE = join(FIXTURES, "fake-claude.mjs");
const TOKEN = "t".repeat(64);
const SESSION_ID = "runner-client-chat";
const HI: Message = { role: "user", content: "hi", timestamp: 0 };
const TOOLS: Tool[] = [{ name: "get_weather", description: "Weather", parameters: { type: "object", properties: {} } }];

const streamEvent = (event: object) => JSON.stringify({ type: "stream_event", event });
const fixtureLines = (name: string) => readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);

/** A runner on port 0 whose claude binary replays `scenario` through fake-claude. */
async function startRunner(t: TestContext, scenario: string[]): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "runner-client-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);
	const bin = join(dir, "claude");
	writeFileSync(bin, [
		"#!/bin/sh",
		`if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; exit 0; fi`,
		`FAKE_CLAUDE_SCENARIO=${scenarioFile} FAKE_CLAUDE_REPORT=1 exec ${process.execPath} ${FAKE_CLAUDE} "$@"`,
		"",
	].join("\n"));
	chmodSync(bin, 0o755);
	const server = createRunner({ claudeBin: bin, token: TOKEN, appHost: "127.0.0.1", killGraceMs: 300 });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.close(); });
	return `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

async function closedAddr(): Promise<string> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return `127.0.0.1:${port}`;
}

async function collect(stream: AssistantMessageEventStream, onEvent: (event: AssistantMessageEvent) => void = () => {}): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		onEvent(event);
	}
	return events;
}

function turn(runClaude: RunClaude, messages: Message[], options?: SimpleStreamOptions, onEvent?: (event: AssistantMessageEvent) => void) {
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: TOOLS });
	return collect(createClaudeCodeStreamFunction(runClaude)(model, context, { sessionId: SESSION_ID, ...options }), onEvent);
}

function last(events: AssistantMessageEvent[]): AssistantMessageEvent {
	const event = events.at(-1);
	assert.ok(event);
	return event;
}

function textOf(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function errorOf(events: AssistantMessageEvent[]): string | undefined {
	const event = last(events);
	assert.equal(event.type, "error");
	return event.type === "error" ? event.error.errorMessage : undefined;
}

test("a text turn streams through the runner", async (t) => {
	const runClaude = createRunnerClient({ addr: await startRunner(t, fixtureLines("text.jsonl")), token: TOKEN });
	const events = await turn(runClaude, [HI]);
	const done = last(events);
	assert.ok(done.type === "done", `turn ended with ${done.type}`);
	assert.equal(done.reason, "stop");
	assert.equal(textOf(done.message), "hello there");
});

test("a tool turn round-trips over the bridge", async (t) => {
	const lines = fixtureLines("tool.jsonl");
	const firstStop = lines.findIndex((line) => line.includes('"type":"message_stop"'));
	const call = { id: "toolu_01JBB4cJsPa585FWb1XrfbNX", name: "get_weather", arguments: { city: "Paris" } };
	const scenario = [
		...lines.slice(0, firstStop + 1).filter((line) => !line.startsWith('{"type":"user"')),
		JSON.stringify({ fake: "call", ...call }),
		JSON.stringify({ fake: "reply" }),
	];
	const runClaude = createRunnerClient({ addr: await startRunner(t, scenario), token: TOKEN });
	// One stream function holds the CLI between the two turns, as in a chat.
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const run = (messages: Message[]) => collect(stream(model, normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: TOOLS }), { sessionId: SESSION_ID }));

	const first = last(await run([HI]));
	assert.ok(first.type === "done" && first.reason === "toolUse", `first turn ended with ${first.type}`);
	assert.deepEqual(first.message.content, [{ type: "toolCall", ...call }]);

	const result: ToolResultMessage = {
		role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "sunny in Paris" }], isError: false, timestamp: 0,
	};
	const reply = last(await run([HI, first.message, result]));
	assert.ok(reply.type === "done", `reply ended with ${reply.type}`);
	assert.equal(textOf(reply.message), "sunny in Paris");
});

test("signed-out CLI fails readably", async (t) => {
	const runClaude = createRunnerClient({ addr: await startRunner(t, fixtureLines("signed-out.jsonl")), token: TOKEN });
	assert.equal(errorOf(await turn(runClaude, [HI])), CLAUDE_CODE_NOT_SIGNED_IN_COPY);
});

test("unreachable runner fails readably", async () => {
	const runClaude = createRunnerClient({ addr: await closedAddr(), token: TOKEN });
	assert.equal(errorOf(await turn(runClaude, [HI])), CLAUDE_CODE_UNREACHABLE_COPY);
});

test("a wrong token fails with the refusal copy", async (t) => {
	const runClaude = createRunnerClient({ addr: await startRunner(t, fixtureLines("text.jsonl")), token: "wrong" });
	assert.equal(errorOf(await turn(runClaude, [HI])), "Claude Code runner refused the request.");
});

test("abort kills the remote process", async (t) => {
	const addr = await startRunner(t, [streamEvent({ type: "message_start", message: { usage: {} } }), JSON.stringify({ fake: "hold" })]);
	const client = createRunnerClient({ addr, token: TOKEN });
	let stderr = "";
	const runClaude: RunClaude = async (request, options) => {
		const child = await client(request, options);
		child?.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
		return child;
	};
	const controller = new AbortController();
	const events = await turn(runClaude, [HI], { signal: controller.signal }, (event) => {
		if (event.type === "start") controller.abort();
	});
	const error = last(events);
	assert.ok(error.type === "error");
	assert.equal(error.reason, "aborted");

	const pid = Number(/fake-pid (\d+)/.exec(stderr)?.[1]);
	assert.ok(pid > 0, `fake did not report its pid: ${stderr}`);
	const deadline = Date.now() + 2000;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (caught) {
			assert.equal((caught as NodeJS.ErrnoException).code, "ESRCH");
			return;
		}
		assert.ok(Date.now() < deadline, "the remote CLI outlived the aborted turn");
		await sleep(20);
	}
});

test("runnerStatus reports the runner's CLI status, and not-found when it can't be reached or refuses", async (t) => {
	const addr = await startRunner(t, fixtureLines("text.jsonl"));
	assert.deepEqual(await runnerStatus({ addr, token: TOKEN }), { state: "meets-minimum", version: "2.1.301", minimumVersion: "2.1.259" });
	const notFound = { state: "not-found", version: null, minimumVersion: "2.1.259" };
	assert.deepEqual(await runnerStatus({ addr, token: "wrong" }), notFound);
	assert.deepEqual(await runnerStatus({ addr: await closedAddr(), token: TOKEN }), notFound);
});
