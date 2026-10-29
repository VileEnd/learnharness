import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-admin-policy-single-"));
process.env.LH_DATA_DIR = dir;
delete process.env.LH_MULTI_USER;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const usageRoute = await import("../app/api/admin/usage/route.ts");

test("single-user usage: one unrestricted local row with no cap", async () => {
	const res = await usageRoute.GET(new Request("http://x/api/admin/usage"));
	assert.equal(res.status, 200);
	const b = (await res.json()) as { users: { userId: string; restricted: boolean; capUsd: number | null }[] };
	assert.equal(b.users.length, 1);
	assert.equal(b.users[0]!.restricted, false);
	assert.equal(b.users[0]!.capUsd, null);
});
