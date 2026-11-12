/**
 * The tests/setup.ts preload: the suite never touches the real data/ or
 * auth.json, and fetch refuses every host but loopback.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AUTH_FILE, DATA_ROOT, ROOT } from "../config.ts";

test("data and key store live in a temp dir, not the repo", () => {
	assert.ok(DATA_ROOT.startsWith(os.tmpdir()), DATA_ROOT);
	assert.ok(AUTH_FILE.startsWith(os.tmpdir()), AUTH_FILE);
	assert.notEqual(DATA_ROOT, path.join(ROOT, "data"));
	assert.notEqual(AUTH_FILE, path.join(ROOT, "auth.json"));
});

test("fetch refuses a non-loopback host", async () => {
	let pending: Promise<Response> | undefined;
	assert.doesNotThrow(() => {
		pending = fetch("https://example.com/");
	}, "a blocked fetch must reject, not throw synchronously");
	await assert.rejects(pending!, /Network blocked/);
	await assert.rejects(async () => fetch("https://example.com/"), /Network blocked in tests: fetch to example\.com/);
	await assert.rejects(async () => fetch(new Request("https://192.0.2.1/x")), /Network blocked/);
});

test("fetch passes loopback through", async () => {
	const server = http.createServer((_req, res) => res.end("ok"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address() as { port: number };
		assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
		assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "ok");
	} finally {
		server.close();
	}
});

// Run the preload alone in a child with a given inherited environment.
const TSX_LOADER = path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs");
function preloaded(inherited: Record<string, string>): { data: string; auth: string } {
	const { LH_DATA_DIR: _d, LH_AUTH_FILE: _a, ...base } = process.env;
	const out = execFileSync(
		process.execPath,
		["--import", TSX_LOADER, "--import", path.join(ROOT, "tests", "setup.ts"), "--eval", "console.log(JSON.stringify({ data: process.env.LH_DATA_DIR, auth: process.env.LH_AUTH_FILE }))"],
		{ cwd: ROOT, env: { ...base, ...inherited }, encoding: "utf-8" },
	);
	return JSON.parse(out) as { data: string; auth: string };
}

test("an inherited data dir or key file outside the temp root is replaced", () => {
	const real = { LH_DATA_DIR: path.join(ROOT, "data"), LH_AUTH_FILE: path.join(ROOT, "auth.json") };
	const got = preloaded(real);
	assert.ok(got.data.startsWith(os.tmpdir()) && got.data !== real.LH_DATA_DIR, got.data);
	assert.ok(got.auth.startsWith(os.tmpdir()) && got.auth !== real.LH_AUTH_FILE, got.auth);
});

test("an inherited data dir and key file under the temp root are kept", () => {
	const kept = { LH_DATA_DIR: path.join(os.tmpdir(), "lh-inherited", "data"), LH_AUTH_FILE: path.join(os.tmpdir(), "lh-inherited", "auth.json") };
	assert.deepEqual(preloaded(kept), { data: kept.LH_DATA_DIR, auth: kept.LH_AUTH_FILE });
});
