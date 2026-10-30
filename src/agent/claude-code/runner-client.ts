/**
 * Client for the Claude Code runner in the `claude` container (deploy/claude/runner.mjs).
 * One TCP connection per CLI run, one JSON object per line in each direction; the
 * protocol is pinned in docs/superpowers/plans/2026-10-30-claude-code-admin.md. The
 * client never sends CLI flags: the runner builds argv, the prompt file and the MCP
 * config from the request, and owns the CLI's environment.
 */
import { EventEmitter } from "node:events";
import net from "node:net";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

import { CLAUDE_CODE_MINIMUM_VERSION, type ClaudeCodeStatus } from "../../core/contracts/claude-code.ts";
import { ClaudeLaunchError } from "./constants.ts";
import type { ClaudeChild, RunClaude } from "./stream.ts";

export type RunnerAddress = { addr: string; token: string };

// Covers the TCP connect and the runner's reply (started, a refusal, or the status). The
// runner's own --version probe can take up to 10 s right after it starts.
const REPLY_TIMEOUT_MS = 15_000;

const ABORT_MESSAGE = "Request was aborted";
const REFUSAL_COPY: Record<string, string> = {
	unauthorized: "Claude Code runner refused the request.",
	invalid: "Claude Code runner refused the request.",
	busy: "Claude Code is busy with another chat. Try again in a moment.",
	update_required: "Claude Code needs an update.",
};

const STATUS_STATES: readonly string[] = ["meets-minimum", "update-required", "version-unchecked", "not-found"];

type Frame = Record<string, unknown>;

function connect(addr: string): net.Socket {
	const split = addr.lastIndexOf(":");
	const host = addr.slice(0, split).replace(/^\[(.*)\]$/, "$1");
	const socket = net.connect({ host, port: Number(addr.slice(split + 1)) });
	socket.setNoDelay(true);
	// A refused or dropped connection always ends in "close", which every caller handles.
	socket.on("error", () => {});
	return socket;
}

function send(socket: net.Socket, frame: Frame): boolean {
	if (socket.destroyed || !socket.writable) return false;
	return socket.write(`${JSON.stringify(frame)}\n`);
}

function readFrames(socket: net.Socket, onFrame: (frame: Frame) => void): void {
	const lines = createInterface({ input: socket, crlfDelay: Infinity });
	// readline re-emits the socket's errors; "close" on the socket handles them.
	lines.on("error", () => {});
	lines.on("line", (line) => {
		if (!line) return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			frame = null;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
			console.error("claude runner sent a malformed frame");
			socket.destroy();
			return;
		}
		onFrame(frame as Frame);
	});
}

/** Resolves when the socket can take more, or is gone. */
function drained(socket: net.Socket): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			socket.off("drain", done);
			socket.off("close", done);
			resolve();
		};
		socket.on("drain", done);
		socket.on("close", done);
	});
}

/** The remote CLI process: stdout/stderr frames feed streams, stdin lines become frames. */
class RemoteChild extends EventEmitter implements ClaudeChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	private closed = false;

	constructor(private readonly socket: net.Socket) {
		super();
		const decoder = new StringDecoder("utf8");
		let pending = "";
		this.stdin = new Writable({
			decodeStrings: false,
			write: (chunk: string | Buffer, _encoding, callback) => {
				pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
				let writable = true;
				let newline;
				while ((newline = pending.indexOf("\n")) !== -1) {
					if (!send(socket, { stdin: pending.slice(0, newline) })) writable = false;
					pending = pending.slice(newline + 1);
				}
				// Lines written after the process is gone are dropped, like writes to a dead pipe.
				if (writable || socket.destroyed) callback();
				else drained(socket).then(() => callback(), callback);
			},
			final: (callback) => {
				pending += decoder.end();
				if (pending) send(socket, { stdin: pending });
				pending = "";
				send(socket, { endStdin: true });
				callback();
			},
		});
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.closed || this.socket.destroyed) return false;
		const sent = send(this.socket, { signal: signal === "SIGKILL" ? "SIGKILL" : "SIGTERM" });
		// SIGKILL is the last word: also hang up, so the runner's disconnect path kills the
		// process group even if the frame is lost, and "close" fires here regardless.
		if (signal === "SIGKILL") this.socket.end();
		return sent;
	}

	handle(frame: Frame): void {
		if (this.closed) return;
		if (typeof frame.stdout === "string") this.stdout.write(`${frame.stdout}\n`);
		else if (typeof frame.stderr === "string") this.stderr.write(frame.stderr);
		else if ("exit" in frame) this.finish(typeof frame.exit === "number" ? frame.exit : null);
		else if (typeof frame.error === "string") {
			const message = typeof frame.message === "string" ? `: ${frame.message}` : "";
			this.stderr.write(`claude runner error ${frame.error}${message}\n`);
		}
	}

	/** Like a ChildProcess, "close" follows the end of both output streams. */
	finish(code: number | null): void {
		if (this.closed) return;
		this.closed = true;
		this.stdout.end();
		this.stderr.end();
		void Promise.allSettled([finished(this.stdout), finished(this.stderr)]).then(() => this.emit("close", code));
	}
}

function refusal(frame: Frame): Error {
	const error = String(frame.error);
	const copy = REFUSAL_COPY[error];
	if (copy) return new ClaudeLaunchError(copy);
	return new Error(`claude runner refused the run (${error}${typeof frame.message === "string" ? `: ${frame.message}` : ""})`);
}

/**
 * A RunClaude over the runner. Resolves with the remote process once the runner reports it
 * started; resolves null when the runner can't be reached; rejects with ClaudeLaunchError
 * (readable copy) when the runner refuses the run.
 */
export function createRunnerClient({ addr, token }: RunnerAddress): RunClaude {
	return (request, { signal } = {}) =>
		new Promise<ClaudeChild | null>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new ClaudeLaunchError(ABORT_MESSAGE));
				return;
			}
			const socket = connect(addr);
			let child: RemoteChild | null = null;
			let settled = false;
			const settle = (result: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				result();
			};
			const onAbort = () => {
				settle(() => reject(new ClaudeLaunchError(ABORT_MESSAGE)));
				socket.destroy();
			};
			const timer = setTimeout(() => {
				settle(() => resolve(null));
				socket.destroy();
			}, REPLY_TIMEOUT_MS);
			signal?.addEventListener("abort", onAbort, { once: true });

			socket.on("close", () => {
				if (child) child.finish(null);
				else settle(() => resolve(null));
			});
			readFrames(socket, (frame) => {
				if (child) {
					child.handle(frame);
				} else if (frame.started === true) {
					const started = new RemoteChild(socket);
					child = started;
					settle(() => resolve(started));
				} else if (typeof frame.error === "string") {
					settle(() => reject(refusal(frame)));
					socket.destroy();
				}
			});
			send(socket, { token, op: "run", run: request });
		});
}

function toStatus(value: unknown): ClaudeCodeStatus | null {
	if (typeof value !== "object" || value === null) return null;
	const { state, version, minimumVersion } = value as Record<string, unknown>;
	if (typeof state !== "string" || !STATUS_STATES.includes(state)) return null;
	if (version !== null && typeof version !== "string") return null;
	if (typeof minimumVersion !== "string") return null;
	return { state: state as ClaudeCodeStatus["state"], version, minimumVersion };
}

/** The runner's CLI status; "not-found" whenever the runner can't be reached or refuses. */
export function runnerStatus({ addr, token }: RunnerAddress): Promise<ClaudeCodeStatus> {
	const notFound: ClaudeCodeStatus = { state: "not-found", version: null, minimumVersion: CLAUDE_CODE_MINIMUM_VERSION };
	return new Promise((resolve) => {
		const socket = connect(addr);
		const done = (status: ClaudeCodeStatus) => {
			clearTimeout(timer);
			resolve(status);
			socket.destroy();
		};
		const timer = setTimeout(() => done(notFound), REPLY_TIMEOUT_MS);
		socket.on("close", () => done(notFound));
		readFrames(socket, (frame) => done(toStatus(frame.status) ?? notFound));
		send(socket, { token, op: "status" });
	});
}
