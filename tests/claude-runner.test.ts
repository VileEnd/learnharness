/**
 * The Claude Code runner (deploy/claude/runner.mjs): auth, request validation,
 * process plumbing and cleanup, driven over real TCP against fake-claude.mjs.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { compareVersion, createRunner, toClaudeArgs } from "../deploy/claude/runner.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude-code/", import.meta.url));
const FAKE_CLAUDE = join(FIXTURES, "fake-claude.mjs");
const TOKEN = "t".repeat(64);
const APP_HOST = "172.30.66.2";
const AUTHORIZATION = `Bearer ${"a".repeat(64)}`;

type Frame = Record<string, unknown>;

function validRun(overrides: Frame = {}): Frame {
	return {
		model: "sonnet",
		effort: "high",
		systemPrompt: "You are a tutor.",
		mcp: { url: `http://${APP_HOST}:3000/mcp`, authorization: AUTHORIZATION },
		allowedTools: ["mcp__learnharness__read"],
		...overrides,
	};
}

/** A claude stand-in: answers --version, otherwise execs fake-claude (so the pid is the fake's). */
function fakeBin(t: TestContext, scenario: string): string {
	const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "claude");
	const holdFile = join(dir, "hold.jsonl");
	writeFileSync(holdFile, `${JSON.stringify({ fake: "hold" })}\n`);
	const scenarioFile = scenario === "hold" ? holdFile : join(FIXTURES, scenario);
	writeFileSync(bin, [
		"#!/bin/sh",
		`if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; exit 0; fi`,
		`echo launched >> ${bin}.launches`,
		`FAKE_CLAUDE_SCENARIO=${scenarioFile} FAKE_CLAUDE_REPORT=1 exec ${process.execPath} ${FAKE_CLAUDE} "$@"`,
		"",
	].join("\n"));
	chmodSync(bin, 0o755);
	return bin;
}

const launched = (bin: string) => existsSync(`${bin}.launches`);

let lastBin = "";

async function listen(t: TestContext, server: net.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.close(); });
	return (server.address() as net.AddressInfo).port;
}

async function startRunner(t: TestContext, scenario = "text.jsonl", options: { maxConcurrent?: number } = {}): Promise<number> {
	lastBin = fakeBin(t, scenario);
	return listen(t, createRunner({ claudeBin: lastBin, token: TOKEN, appHost: APP_HOST, killGraceMs: 300, ...options }));
}

function connect(t: TestContext, port: number) {
	const socket = net.connect(port, "127.0.0.1");
	t.after(() => socket.destroy());
	const frames: Frame[] = [];
	let buffer = "";
	let closed = false;
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			frames.push(JSON.parse(buffer.slice(0, newline)) as Frame);
			buffer = buffer.slice(newline + 1);
		}
	});
	socket.on("close", () => { closed = true; });
	socket.on("error", () => {});

	return {
		socket,
		frames,
		send: (frame: Frame) => socket.write(`${JSON.stringify(frame)}\n`),
		async until(done: () => boolean, ms = 5000): Promise<void> {
			const deadline = Date.now() + ms;
			while (!done()) {
				assert.ok(Date.now() < deadline, `timed out; frames: ${JSON.stringify(frames).slice(0, 500)}`);
				await sleep(10);
			}
		},
		closed: () => closed,
	};
}

const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

function fakePid(frames: Frame[]): number {
	const text = frames.map((frame) => (typeof frame.stderr === "string" ? frame.stderr : "")).join("");
	const match = /fake-pid (\d+)/.exec(text);
	assert.ok(match, "fake did not report its pid");
	return Number(match[1]);
}

test("rejects a wrong token", async (t) => {
	const client = connect(t, await startRunner(t));
	client.send({ token: "wrong", op: "status" });
	await client.until(() => client.closed());
	assert.deepEqual(client.frames, [{ error: "unauthorized" }]);
});

test("reports the CLI status", async (t) => {
	const client = connect(t, await startRunner(t));
	client.send({ token: TOKEN, op: "status" });
	await client.until(() => client.closed());
	assert.deepEqual(client.frames, [{ status: { state: "meets-minimum", version: "2.1.301", minimumVersion: "2.1.259" } }]);
});

/** Sends one first frame and returns every frame the runner sent before closing. */
async function exchange(t: TestContext, port: number, frame: Frame): Promise<Frame[]> {
	const client = connect(t, port);
	client.send(frame);
	await client.until(() => client.closed());
	return client.frames;
}

test("refuses a run readably when the CLI is missing", async (t) => {
	const port = await listen(t, createRunner({ claudeBin: "/nonexistent/claude", token: TOKEN, appHost: APP_HOST }));
	assert.deepEqual(await exchange(t, port, { token: TOKEN, op: "run", run: validRun() }), [{ error: "spawn_failed", message: "claude CLI not found in the container" }]);
});

test("re-probes an unchecked CLI version on demand, at most once per window", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "claude");
	writeFileSync(bin, `#!/bin/sh\nif [ -f ${dir}/fixed ]; then echo "2.1.301 (Claude Code)"; fi\n`);
	chmodSync(bin, 0o755);
	const eager = await listen(t, createRunner({ claudeBin: bin, token: TOKEN, appHost: APP_HOST, reprobeMs: 0 }));
	const throttled = await listen(t, createRunner({ claudeBin: bin, token: TOKEN, appHost: APP_HOST }));
	const state = async (port: number) => ((await exchange(t, port, { token: TOKEN, op: "status" }))[0]?.status as Frame | undefined)?.state;

	assert.deepEqual(await exchange(t, eager, { token: TOKEN, op: "run", run: validRun() }), [{ error: "spawn_failed", message: "Claude Code's version couldn't be checked" }]);
	assert.equal(await state(throttled), "version-unchecked");
	writeFileSync(join(dir, "fixed"), "");
	assert.equal(await state(eager), "meets-minimum");
	assert.equal(await state(throttled), "version-unchecked");
});

test("refuses an MCP url on another host and a non-MCP tool", async (t) => {
	const port = await startRunner(t);
	for (const run of [
		validRun({ mcp: { url: "http://10.0.0.9:1/mcp", authorization: AUTHORIZATION } }),
		validRun({ allowedTools: ["Bash"] }),
	]) {
		const client = connect(t, port);
		client.send({ token: TOKEN, op: "run", run });
		await client.until(() => client.closed());
		assert.equal(client.frames[0]?.error, "invalid");
	}
});

test("refuses unknown keys", async (t) => {
	const client = connect(t, await startRunner(t));
	client.send({ token: TOKEN, op: "run", run: validRun({ args: ["--dangerously-skip-permissions"] }) });
	await client.until(() => client.closed());
	assert.equal(client.frames[0]?.error, "invalid");
});

test("streams a text turn", async (t) => {
	const client = connect(t, await startRunner(t));
	client.send({ token: TOKEN, op: "run", run: validRun() });
	client.send({ stdin: userLine("hi") });
	client.send({ endStdin: true });
	await client.until(() => client.closed());
	assert.deepEqual(client.frames[0], { started: true });
	assert.ok(client.frames.some((frame) => typeof frame.stdout === "string" && frame.stdout.includes("message_start")));
	assert.deepEqual(client.frames.at(-1), { exit: 0, signal: null });
});

test("kills the CLI when the client disconnects", async (t) => {
	const client = connect(t, await startRunner(t, "hold"));
	client.send({ token: TOKEN, op: "run", run: validRun() });
	client.send({ stdin: userLine("hi") });
	await client.until(() => client.frames.some((frame) => typeof frame.stderr === "string" && frame.stderr.includes("fake-stdin")));
	const pid = fakePid(client.frames);
	process.kill(pid, 0);
	client.socket.destroy();
	const deadline = Date.now() + 1500;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
			return;
		}
		assert.ok(Date.now() < deadline, "the CLI outlived its client");
		await sleep(20);
	}
});

test("third concurrent run is busy", async (t) => {
	const port = await startRunner(t, "hold");
	const running = [];
	for (let i = 0; i < 2; i++) {
		const client = connect(t, port);
		client.send({ token: TOKEN, op: "run", run: validRun() });
		await client.until(() => client.frames.some((frame) => frame.started === true));
		running.push(client);
	}
	const third = connect(t, port);
	third.send({ token: TOKEN, op: "run", run: validRun() });
	await third.until(() => third.closed());
	assert.equal(third.frames[0]?.error, "busy");
});

test("passes a 5 MB stdin line intact", async (t) => {
	const client = connect(t, await startRunner(t));
	const line = userLine("x".repeat(5 * 1024 * 1024));
	client.send({ token: TOKEN, op: "run", run: validRun() });
	client.send({ stdin: line });
	client.send({ endStdin: true });
	await client.until(() => client.closed(), 15000);
	const stderr = client.frames.map((frame) => (typeof frame.stderr === "string" ? frame.stderr : "")).join("");
	assert.ok(stderr.includes(`fake-stdin ${line.length}\n`), stderr);
	assert.deepEqual(client.frames.at(-1), { exit: 0, signal: null });
});

async function waitGone(pid: number): Promise<void> {
	const deadline = Date.now() + 1500;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
			return;
		}
		assert.ok(Date.now() < deadline, "the CLI outlived its connection");
		await sleep(20);
	}
}

test("a frame after a refusal does not spawn the CLI", async (t) => {
	const second = connect(t, await startRunner(t));
	second.socket.write("not json\n");
	second.socket.write(`${JSON.stringify({ token: TOKEN, op: "run", run: validRun() })}\n`);
	await second.until(() => second.closed());
	await sleep(300);
	assert.equal(second.frames[0]?.error, "invalid");
	assert.equal(launched(lastBin), false);
});

test("a frame over 32 MiB is refused", async (t) => {
	const client = connect(t, await startRunner(t));
	client.socket.write(`${JSON.stringify({ token: TOKEN, op: "status", pad: "x".repeat(33 * 1024 * 1024) })}\n`);
	await client.until(() => client.closed(), 15000);
	assert.equal(client.frames[0]?.error, "invalid");
});

test("an oversized frame during a run kills the CLI", async (t) => {
	const client = connect(t, await startRunner(t, "hold"));
	client.send({ token: TOKEN, op: "run", run: validRun() });
	client.send({ stdin: userLine("hi") });
	await client.until(() => client.frames.some((frame) => typeof frame.stderr === "string" && frame.stderr.includes("fake-stdin")));
	const pid = fakePid(client.frames);
	client.socket.write(`${JSON.stringify({ stdin: "x".repeat(33 * 1024 * 1024) })}\n`);
	await client.until(() => client.closed(), 15000);
	assert.ok(client.frames.some((frame) => frame.error === "invalid"));
	await waitGone(pid);
});

test("toClaudeArgs matches upstream", () => {
	assert.deepEqual(
		toClaudeArgs({ model: "sonnet", effort: "high", systemPromptFile: "/w/system.md", mcpConfigFile: "/w/mcp.json", allowedTools: ["mcp__learnharness__read", "mcp__learnharness__quiz"] }),
		[
			"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
			"--model", "sonnet", "--effort", "high", "--system-prompt-file", "/w/system.md", "--tools", "",
			"--strict-mcp-config", "--mcp-config", "/w/mcp.json", "--setting-sources", "user",
			"--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-session-persistence",
			"--permission-prompts", "none", "--allowedTools", "mcp__learnharness__read,mcp__learnharness__quiz",
		],
	);
});

test("compareVersion orders versions numerically", () => {
	assert.equal(compareVersion("2.1.258", "2.1.259"), -1);
	assert.equal(compareVersion("2.1.259", "2.1.259"), 0);
	assert.equal(compareVersion("2.10.0", "2.9.9"), 1);
});
