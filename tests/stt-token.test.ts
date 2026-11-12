/** GET /api/stt/token mints on the shared key: the spend cap applies and each mint is one request-log line. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stt-token-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
process.env.DEEPGRAM_API_KEY = "dg-test-key-0123456789";
delete process.env.LH_ADMIN_GROUP;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { stores } = await import("../src/server/stores.ts");
const policy = await import("../src/server/policy.ts");
const { setRequestSink } = await import("../src/agent/request-log.ts");
const route = await import("../app/api/stt/token/route.ts");
import type { RequestLogLine } from "../src/core/contracts/usage.ts";

const M = (id: string) => ({ provider: "openrouter", id });
const POLICY = { slots: { strong: M("a/strong"), cheap: M("a/cheap"), vision: M("a/cheap") }, allowedModels: [], monthlyCapUsd: 5 };
const OVER = { id: "user-over", name: "o", isAdmin: false };
const UNDER = { id: "user-under", name: "u", isAdmin: false };
for (const t of [OVER, UNDER]) policy.setUserPolicy(t.id, POLICY);
runAsTenant(OVER, () =>
	stores.requestLog.append({ v: 1, at: new Date().toISOString(), purpose: "teacher", category: "teaching", provider: "openrouter", model: "a/strong", outcome: "ok", providerCostUsd: 5.1 }),
);

const originalFetch = globalThis.fetch;
let grants = 0;
let lines: RequestLogLine[] = [];
globalThis.fetch = (async () => {
	grants++;
	return Response.json({ access_token: "minted-secret-value" });
}) as typeof fetch;
setRequestSink((line) => lines.push(line));
afterEach(() => {
	grants = 0;
	lines = [];
});
after(() => {
	globalThis.fetch = originalFetch;
	setRequestSink(null);
});

const get = (t: { id: string }) => route.GET(new Request("http://x/api/stt/token", { headers: { "x-auth-request-user": t.id, "x-auth-request-groups": "/learnharness" } }));

test("a user over their monthly cap gets 403 and no token is minted", async () => {
	const res = await get(OVER);
	assert.equal(res.status, 403);
	assert.equal(((await res.json()) as { code: string }).code, "monthly_cap_reached");
	assert.equal(grants, 0);
	assert.equal(lines.length, 0);
});

test("a mint within the cap returns the token and writes one metadata-only line with no cost", async () => {
	const res = await get(UNDER);
	assert.deepEqual(await res.json(), { token: "minted-secret-value" });
	assert.equal(grants, 1);
	assert.equal(lines.length, 1);
	const line = lines[0]!;
	assert.equal(line.purpose, "dictation");
	assert.equal(line.provider, "deepgram");
	assert.equal(line.outcome, "ok");
	assert.equal("providerCostUsd" in line, false);
	assert.equal(JSON.stringify(line).includes("minted-secret-value"), false);
});
