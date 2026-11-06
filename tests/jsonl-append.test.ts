/**
 * A torn JSONL tail (last line without a newline after a crash) must not
 * swallow the next appended record: the append starts a new line, and the
 * readers skip only the torn line. Isolated LH_DATA_DIR before any import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-jsonl-append-"));
process.env.LH_DATA_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { LEDGER_FILES } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { requestLogStore } = await import("../src/store/request-log.ts");
const { appendJsonlSync } = await import("../src/store/jsonl-append.ts");

it("appends to a torn tail on a new line, in a graph ledger and the request log", () => {
	const node = (id: string) => ({ id, name: id, statement: `${id} holds.`, aliases: [], createdAt: "2026-10-21T09:00:00.000Z", provenance: [] });
	graphStore.appendNode(node("n1"));
	fs.appendFileSync(LEDGER_FILES.nodes, '{"id":"torn","na'); // crash mid-append
	graphStore.appendNode(node("n2"));
	assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["n1", "n2"]);

	const line = (at: string) => ({ v: 1 as const, at, purpose: "teacher", category: "teaching" as const, provider: "p", model: "m", outcome: "ok" as const });
	requestLogStore.append(line("2026-11-02T10:00:00Z"));
	const log = path.join(root, "logs", "requests-2026-11.jsonl");
	fs.appendFileSync(log, '{"v":1,"at":"2026');
	requestLogStore.append(line("2026-11-03T10:00:00Z"));
	assert.equal(requestLogStore.readMonth("2026-11").length, 2);
});

it("leaves well-formed files alone: no blank lines, new files are created", () => {
	const file = path.join(root, "x.jsonl");
	appendJsonlSync(file, { a: 1 });
	appendJsonlSync(file, { a: 2 });
	assert.equal(fs.readFileSync(file, "utf-8"), '{"a":1}\n{"a":2}\n');
});
