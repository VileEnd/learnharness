import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolated legacy-layout data dir BEFORE any config-loading import.
const FIXTURE = path.resolve("tests/fixtures/golden-data");
const SCRIPT = path.resolve("scripts/migrate-to-tenants.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";

const list = (root: string): string[] =>
	fs.readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => path.relative(root, path.join(e.parentPath, e.name)))
		.sort();

fs.cpSync(FIXTURE, dir, { recursive: true });
const before = list(dir);

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { PATHS, LegacyLayoutError, legacyLayoutPresent } = await import("../config.ts");
const { GET } = await import("../app/api/health/route.ts");

const A = { id: "a", name: "A", isAdmin: false };

test("legacy layout: health is 503 and tenant paths refuse", async () => {
	assert.equal(legacyLayoutPresent(), true);
	const res = await GET();
	assert.equal(res.status, 503);
	const body = (await res.json()) as { error: string; fix: string };
	assert.equal(body.error, "legacy_layout");
	assert.match(body.fix, /node scripts\/migrate-to-tenants\.mjs --owner <keycloak-sub>/);
	assert.throws(() => runAsTenant(A, () => PATHS.chats), LegacyLayoutError);
});

test("malformed owner exits 1 without changes", () => {
	const r = spawnSync(process.execPath, [SCRIPT, "--owner", "Foo@x"], { env: { ...process.env, LH_DATA_DIR: dir } });
	assert.equal(r.status, 1);
	assert.deepEqual(list(dir), before);
});

test("migration moves everything under users/a, shares vapid and prompts", async () => {
	fs.mkdirSync(path.join(dir, "push"), { recursive: true });
	fs.writeFileSync(path.join(dir, "push", "vapid.json"), "{}");
	fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
	fs.writeFileSync(path.join(dir, "prompts", "x.md"), "x");
	const expected = list(dir);
	const run = () => execFileSync(process.execPath, [SCRIPT, "--owner", "a"], { env: { ...process.env, LH_DATA_DIR: dir } });
	run();
	const moved = list(path.join(dir, "users", "a"));
	assert.deepEqual(
		[...moved, ...list(path.join(dir, "global")).map((p) => p)].sort(),
		expected.map((p) => (p === "push/vapid.json" ? "push/vapid.json" : p)).sort(),
	);
	assert.ok(fs.existsSync(path.join(dir, "global", "push", "vapid.json")));
	assert.ok(fs.existsSync(path.join(dir, "global", "prompts", "x.md")));
	assert.deepEqual(moved.filter((p) => !p.startsWith("push/") && !p.startsWith("prompts/")), before);
	assert.throws(run, (e: { status?: number }) => e.status === 1);
	assert.equal(legacyLayoutPresent(), false);
	assert.equal((await GET()).status, 200);
	assert.equal(runAsTenant(A, () => PATHS.chats), path.join(dir, "users", "a", "chats"));
});
