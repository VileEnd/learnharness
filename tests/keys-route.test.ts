/** GET /api/keys: admins see the masked details, everyone else only which keys are present. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-keys-route-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const keys = await import("../src/server/keys.ts");
const route = await import("../app/api/keys/route.ts");

const get = async (groups: string) => {
	const res = await route.GET(new Request("http://x/api/keys", { headers: { "x-auth-request-user": "user-a", "x-auth-request-groups": groups } }));
	return (await res.json()) as { keys: Record<string, unknown>[]; providers: unknown[] };
};

test("a non-admin gets {id, present} per key and the provider list, nothing else", async () => {
	assert.equal(keys.saveKey("OPENAI_API_KEY", "ordinary-provider-key-abcd").ok, true);
	try {
		const body = await get("/learnharness");
		const row = body.keys.find((k) => k.id === "OPENAI_API_KEY")!;
		assert.deepEqual(row, { id: "OPENAI_API_KEY", present: true });
		for (const k of body.keys) assert.deepEqual(Object.keys(k).sort(), ["id", "present"]);
		assert.ok(body.providers.length > 0);
		assert.ok(!JSON.stringify(body).includes("abcd"));
	} finally {
		keys.deleteKey("OPENAI_API_KEY");
	}
});

test("an admin still gets the masked tail, length and source", async () => {
	assert.equal(keys.saveKey("OPENAI_API_KEY", "ordinary-provider-key-abcd").ok, true);
	try {
		const row = (await get("/learnharness,/learnharness-admin")).keys.find((k) => k.id === "OPENAI_API_KEY")!;
		assert.equal(row.masked, "…abcd (26 chars)");
		assert.equal(row.source, "file");
	} finally {
		keys.deleteKey("OPENAI_API_KEY");
	}
});
