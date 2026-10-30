// TCP runner for the Claude Code CLI (docs/self-hosting.md, "Claude Code").
// Runs inside the locked-down `claude` container: node built-ins only, no
// dependency on the app. The app sends one JSON object per line. The runner
// never takes flags from the caller: argv comes only from toClaudeArgs.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MINIMUM_VERSION = "2.1.259";
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 10_000;
const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const RUN_KEYS = ["model", "effort", "systemPrompt", "mcp", "allowedTools"];
const AUTHORIZATION = /^Bearer [0-9a-f]{64}$/;
const EMPTY_CWD = "/tmp/claude-code-empty";
const TOOL = /^mcp__learnharness__[A-Za-z0-9_-]{1,64}$/;

export function toClaudeArgs(input) {
	return [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		input.model,
		"--effort",
		input.effort,
		"--system-prompt-file",
		input.systemPromptFile,
		"--tools",
		"",
		"--strict-mcp-config",
		"--mcp-config",
		input.mcpConfigFile,
		"--setting-sources",
		"user",
		"--settings",
		JSON.stringify({ disableAllHooks: true }),
		"--disable-slash-commands",
		"--no-session-persistence",
		"--permission-prompts",
		"none",
		...(input.allowedTools.length > 0 ? ["--allowedTools", input.allowedTools.join(",")] : []),
	];
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => own.includes(key));
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateRun(body, appHost) {
	const invalid = (message) => ({ ok: false, message });
	if (!isRecord(body) || !hasOnlyKeys(body, RUN_KEYS)) return invalid(`run must have exactly the keys ${RUN_KEYS.join(", ")}`);
	if (!MODELS.includes(body.model)) return invalid("unknown model");
	if (!EFFORTS.includes(body.effort)) return invalid("unknown effort");
	if (typeof body.systemPrompt !== "string") return invalid("systemPrompt must be a string");
	const { mcp, allowedTools } = body;
	if (!isRecord(mcp) || !hasOnlyKeys(mcp, ["url", "authorization"])) return invalid("mcp must have exactly url and authorization");
	if (typeof mcp.url !== "string") return invalid("mcp.url must be a string");
	const match = new RegExp(`^http://${escapeRegExp(appHost)}:(\\d{1,5})/mcp$`).exec(mcp.url);
	if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return invalid("mcp.url must be http://<app host>:<port>/mcp");
	if (typeof mcp.authorization !== "string" || !AUTHORIZATION.test(mcp.authorization)) return invalid("mcp.authorization is malformed");
	if (!Array.isArray(allowedTools) || allowedTools.length > 64) return invalid("allowedTools must be an array of at most 64 entries");
	if (!allowedTools.every((tool) => typeof tool === "string" && TOOL.test(tool))) return invalid("allowedTools holds a disallowed entry");

	return {
		ok: true,
		run: {
			model: body.model,
			effort: body.effort,
			systemPrompt: body.systemPrompt,
			mcp: { url: mcp.url, authorization: mcp.authorization },
			allowedTools: [...allowedTools],
		},
	};
}

export function compareVersion(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

function probeVersion(claudeBin, env) {
	return new Promise((resolve) => {
		const result = (state, version) => resolve({ state, version, minimumVersion: MINIMUM_VERSION });
		let out = "";
		const child = spawn(claudeBin, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"], timeout: VERSION_TIMEOUT_MS });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.on("error", (error) => result(error.code === "ENOENT" ? "not-found" : "version-unchecked", null));
		child.on("close", () => {
			const version = /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
			if (version === null) result("version-unchecked", null);
			else result(compareVersion(version, MINIMUM_VERSION) >= 0 ? "meets-minimum" : "update-required", version);
		});
	});
}

function tokenMatches(given, expected) {
	if (typeof given !== "string") return false;
	const digest = (text) => createHash("sha256").update(text).digest();
	return timingSafeEqual(digest(given), digest(expected));
}

export function createRunner({ claudeBin, token, appHost, maxConcurrent = 2, killGraceMs = 1000 }) {
	const baseEnv = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? "",
		DISABLE_AUTOUPDATER: "1",
		MCP_TOOL_TIMEOUT: "1800000",
	};
	const status = probeVersion(claudeBin, baseEnv);
	let active = 0;

	function handleConnection(socket) {
		const send = (frame) => {
			if (socket.destroyed || !socket.writable) return true;
			return socket.write(`${JSON.stringify(frame)}\n`);
		};
		let stopped = false;
		const refuse = (error, message) => {
			if (stopped) return;
			stopped = true;
			if (child) killWithGrace();
			const frame = `${JSON.stringify(error === "unauthorized" ? { error } : { error, message })}\n`;
			socket.end(frame, () => socket.destroy());
		};

		let child = null;
		let first = true;
		let running = false;
		let closed = false;
		let killTimer = null;
		let chunks = [];
		let pending = 0;
		const queued = [];
		const firstTimer = setTimeout(() => socket.destroy(), FIRST_FRAME_TIMEOUT_MS);
		firstTimer.unref();

		const killChild = (signal) => {
			if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
			try {
				process.kill(-child.pid, signal);
			} catch {
				try { child.kill(signal); } catch { /* already gone */ }
			}
		};
		const killWithGrace = () => {
			killChild("SIGTERM");
			killTimer ??= setTimeout(() => killChild("SIGKILL"), killGraceMs);
			killTimer.unref();
		};

		function applyToChild(frame) {
			if (typeof frame.stdin === "string") child.stdin.write(`${frame.stdin}\n`);
			else if (frame.endStdin === true) child.stdin.end();
			else if (frame.signal === "SIGTERM" || frame.signal === "SIGKILL") killChild(frame.signal);
		}

		function startRun(request) {
			const checked = validateRun(request, appHost);
			if (!checked.ok) return refuse("invalid", checked.message);
			running = true;
			status.then((info) => {
				if (closed) return;
				if (info.state !== "meets-minimum") return refuse("update_required", `claude CLI is ${info.state}`);
				if (active >= maxConcurrent) return refuse("busy", "too many concurrent runs");
				launch(checked.run);
			});
		}

		function launch(run) {
			let dir;
			try {
				dir = mkdtempSync("/tmp/claude-run-");
				const systemPromptFile = join(dir, "system-prompt.md");
				const mcpConfigFile = join(dir, "mcp.json");
				writeFileSync(systemPromptFile, run.systemPrompt, { mode: 0o600 });
				writeFileSync(mcpConfigFile, JSON.stringify({
					mcpServers: { learnharness: { type: "http", url: run.mcp.url, headers: { Authorization: run.mcp.authorization } } },
				}), { mode: 0o600 });
				mkdirSync(EMPTY_CWD, { recursive: true });
				child = spawn(claudeBin, toClaudeArgs({
					model: run.model,
					effort: run.effort,
					systemPromptFile,
					mcpConfigFile,
					allowedTools: run.allowedTools,
				}), { cwd: EMPTY_CWD, env: baseEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
			} catch (error) {
				if (dir) rmSync(dir, { recursive: true, force: true });
				return refuse("spawn_failed", error instanceof Error ? error.message : String(error));
			}
			active++;

			let done = false;
			const finish = (frame) => {
				if (done) return;
				done = true;
				active--;
				clearTimeout(killTimer);
				rmSync(dir, { recursive: true, force: true });
				send(frame);
				socket.end();
			};
			child.once("spawn", () => send({ started: true }));
			child.once("error", (error) => {
				if (child.pid === undefined) finish({ error: "spawn_failed", message: error.message });
			});
			child.stdin.on("error", () => {});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => send({ stderr: chunk }));
			child.stdout.setEncoding("utf8");
			let tail = "";
			child.stdout.on("data", (chunk) => {
				tail += chunk;
				let newline;
				let backpressure = false;
				while ((newline = tail.indexOf("\n")) !== -1) {
					const line = tail.slice(0, newline);
					tail = tail.slice(newline + 1);
					if (!send({ stdout: line })) backpressure = true;
				}
				if (backpressure) {
					child.stdout.pause();
					socket.once("drain", () => child.stdout.resume());
				}
			});
			child.stdout.on("end", () => {
				if (tail) send({ stdout: tail });
				tail = "";
			});
			child.once("close", (code, signal) => {
				// Anything the CLI left behind in its process group goes with it.
				try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already empty */ }
				finish({ exit: code, signal });
			});

			for (const frame of queued.splice(0)) applyToChild(frame);
		}

		function handleFrame(text) {
			let frame;
			const wasFirst = first;
			first = false;
			clearTimeout(firstTimer);
			try {
				frame = JSON.parse(text);
			} catch {
				return refuse("invalid", "frame is not JSON");
			}
			if (!isRecord(frame)) return refuse("invalid", "frame must be an object");
			if (wasFirst) {
				if (!tokenMatches(frame.token, token)) return refuse("unauthorized");
				if (frame.op === "status") {
					return void status.then((info) => {
						send({ status: info });
						socket.end();
					});
				}
				if (frame.op === "run") return startRun(frame.run);
				return refuse("invalid", "unknown op");
			}
			if (!running) return;
			if (child) applyToChild(frame);
			else queued.push(frame);
		}

		socket.on("data", (data) => {
			if (stopped) return;
			let start = 0;
			let newline;
			while ((newline = data.indexOf(10, start)) !== -1) {
				chunks.push(data.subarray(start, newline));
				pending += newline - start;
				start = newline + 1;
				const oversized = pending > MAX_FRAME_BYTES;
				const text = oversized ? "" : Buffer.concat(chunks).toString("utf8");
				chunks = [];
				pending = 0;
				if (oversized) return refuse("invalid", "frame exceeds 32 MiB");
				if (text.length > 0) handleFrame(text);
				if (stopped) return;
			}
			if (start < data.length) {
				chunks.push(data.subarray(start));
				pending += data.length - start;
				if (pending > MAX_FRAME_BYTES) {
					chunks = [];
					pending = 0;
					refuse("invalid", "frame exceeds 32 MiB");
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			closed = true;
			clearTimeout(firstTimer);
			if (child) killWithGrace();
		});
	}

	return net.createServer(handleConnection);
}

function main() {
	const token = process.env.CLAUDE_RUNNER_TOKEN;
	const appHost = process.env.LH_APP_HOST;
	const listen = process.env.CLAUDE_RUNNER_LISTEN;
	if (!token || !appHost || !listen) {
		console.error("CLAUDE_RUNNER_TOKEN, LH_APP_HOST and CLAUDE_RUNNER_LISTEN are required");
		process.exit(1);
	}
	const split = listen.lastIndexOf(":");
	const server = createRunner({ claudeBin: process.env.CLAUDE_BIN ?? "claude", token, appHost });
	server.listen(Number(listen.slice(split + 1)), listen.slice(0, split), () => console.log(`claude runner listening on ${listen}`));
	for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
