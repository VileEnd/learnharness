import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reqlog-"));
process.env.LH_DATA_DIR = dir;

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const mk = (at: string) => ({
	v: 1 as const,
	at,
	purpose: "teacher",
	category: "teaching" as const,
	provider: "p",
	model: "m",
	outcome: "ok" as const,
});

test("request log store", async () => {
	const { requestLogStore: s } = await import("../src/store/request-log.ts");
	const { PATHS } = await import("../config.ts");
	assert.equal(fs.existsSync(PATHS.logs), false);
	assert.deepEqual(s.months(), []);
	assert.equal(s.backfillDone(), false);

	s.append(mk("2026-11-02T10:00:00Z"));
	s.append(mk("2026-10-02T10:00:00Z"));
	assert.deepEqual(s.months(), ["2026-10", "2026-11"]);
	assert.equal(s.readMonth("2026-10").length, 1);

	fs.appendFileSync(path.join(PATHS.logs, "requests-2026-10.jsonl"), '{"v":1,"at":"2026');
	assert.equal(s.readMonth("2026-10").length, 1);

	assert.equal(s.backfillDone(), false);
	s.markBackfilled();
	assert.equal(s.backfillDone(), true);

	fs.appendFileSync(path.join(PATHS.logs, "requests-2026-10.jsonl"), `${JSON.stringify({ ...mk("2026-10-03T10:00:00Z"), category: "bogus" })}\n`);
	assert.equal(s.readMonth("2026-10").length, 1);
});
