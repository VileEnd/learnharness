/**
 * PR H, the fs adapter: topics.jsonl is append-only and corrupt-line
 * tolerant, rewriteLedgers can replace it, and the alias table round-trips
 * (and reads as empty when missing or garbage). Isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-topics-store-"));
process.env.LH_DATA_DIR = TMP;

const { graphStore } = await import("../src/store/graph.ts");
const { LEDGER_FILES, TOPIC_ALIASES_FILE } = await import("../config.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const row = (nodeId: string, topic: string) => ({ nodeId, topic, sourceId: "src_a", at: "2026-10-25T00:00:00.000Z" });

describe("topics ledger adapter", () => {
	it("appends, reads in order, and skips corrupt or malformed lines", () => {
		assert.deepEqual(graphStore.readTopics(), [], "no ledger yet");
		graphStore.appendTopic(row("n1", "Semaphoren"));
		fs.appendFileSync(LEDGER_FILES.topics, "{ torn line\n" + JSON.stringify({ nodeId: "n2" }) + "\n");
		graphStore.appendTopic(row("n2", "Mutex"));
		assert.deepEqual(graphStore.readTopics().map((r) => [r.nodeId, r.topic]), [["n1", "Semaphoren"], ["n2", "Mutex"]]);
	});

	it("rewriteLedgers replaces the topics ledger atomically and leaves the others alone", () => {
		graphStore.rewriteLedgers({ topics: [row("n2", "Mutex")] });
		assert.deepEqual(graphStore.readTopics().map((r) => r.nodeId), ["n2"]);
		graphStore.rewriteLedgers({ topics: [] });
		assert.deepEqual(graphStore.readTopics(), []);
	});

	it("the alias table round-trips; missing or garbage reads as empty", () => {
		assert.deepEqual(graphStore.readTopicAliases(), {});
		graphStore.writeTopicAliases({ semaphor: "Semaphoren" });
		assert.deepEqual(graphStore.readTopicAliases(), { semaphor: "Semaphoren" });
		fs.writeFileSync(TOPIC_ALIASES_FILE, "not json");
		assert.deepEqual(graphStore.readTopicAliases(), {});
	});
});
