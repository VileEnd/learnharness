/**
 * The tests/setup.ts preload: the suite never touches the real data/ or
 * auth.json, and fetch refuses every host but loopback.
 */
import assert from "node:assert/strict";
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
