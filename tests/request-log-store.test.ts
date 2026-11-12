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

test("readMonthSince hands out only the lines appended since the cursor", async () => {
	const { requestLogStore: s } = await import("../src/store/request-log.ts");
	const { PATHS } = await import("../config.ts");
	const month = "2026-09";
	const log = path.join(PATHS.logs, `requests-${month}.jsonl`);
	assert.deepEqual(s.readMonthSince(month, null).lines, []);

	s.append(mk("2026-09-01T10:00:00Z"));
	s.append(mk("2026-09-02T10:00:00Z"));
	const first = s.readMonthSince(month, null);
	assert.equal(first.lines.length, 2);
	assert.equal(first.reset, true);

	assert.deepEqual(s.readMonthSince(month, first.cursor), { lines: [], cursor: first.cursor, reset: false });

	// A record another writer is still appending is left for the next read.
	fs.appendFileSync(log, '{"v":1,"at":"2026');
	const torn = s.readMonthSince(month, first.cursor);
	assert.equal(torn.lines.length, 0);
	assert.equal(torn.cursor.offset, first.cursor.offset);
	s.append(mk("2026-09-03T10:00:00Z")); // the torn fragment ends here, the new record is whole
	const next = s.readMonthSince(month, torn.cursor);
	assert.equal(next.lines.length, 1);
	assert.equal(next.reset, false);
	assert.deepEqual(s.readMonth(month).length, 3);

	// A file that shrank or was replaced starts over from its beginning.
	fs.rmSync(log);
	s.append(mk("2026-09-04T10:00:00Z"));
	const again = s.readMonthSince(month, next.cursor);
	assert.equal(again.reset, true);
	assert.equal(again.lines.length, 1);
});
