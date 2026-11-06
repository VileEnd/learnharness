/**
 * SESSION-KIND PINS (practice sessions, owner 2026-10-04): ChatRecord.kind
 * is ABSENT-BY-DEFAULT — absence reads as teach, so pre-practice records
 * never migrate; "practice" marks an adaptive-practice session (the
 * practice agent + its two tools from turn 1, no extraction, no graph
 * writes). The store normalizes at the summary projection; createChat
 * stamps the marker only for practice. Runs under an isolated LH_DATA_DIR
 * (the chat-birth-stamp discipline: the seam is set before any
 * config-loading import, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

const { PRACTICE_PROBLEM_TOOL, PRACTICE_CONCLUDE_TOOL, newProblemDismissedMarker, newWorkDismissedMarker } = await import(
	"../src/core/native-messages.ts"
);
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

/** A cleanly acked tool call (assistant call + non-error result). */
function ackedCall(name: string, callId: string, args: Record<string, string> = {}): LhMessage[] {
	return [
		{
			id: `msg_a_${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name, arguments: args }],
			api: "faux",
			provider: "test",
			model: "test-model",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			id: `msg_r_${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: name,
			content: [{ type: "text", text: "ok" }],
			details: null,
			isError: false,
			timestamp: 2,
		},
	];
}

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("session kind (practice sessions, 2026-10-04)", () => {
	it("createChat default carries NO kind field — absence reads as teach", () => {
		const chat = chatStore.createChat("plain session");
		assert.equal("kind" in chat, false, "teach records carry no kind marker");
	});

	it("createChat(kind: 'practice') stamps the marker on record + list", () => {
		const chat = chatStore.createChat("practice session", "practice");
		assert.equal(chat.kind, "practice");
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.kind, "practice");
	});

	it("the summary projection NORMALIZES: absent record field reads as teach", () => {
		const chat = chatStore.createChat("another plain one");
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.kind, "teach");
	});
});

describe("list projection: waiting states", () => {
	const listed = (name: string, kind: "teach" | "practice", messages: LhMessage[]) => {
		const chat = chatStore.createChat(name, kind === "practice" ? "practice" : undefined);
		chatStore.saveMessages(chat.id, messages);
		return chatStore.listChats().find((c) => c.id === chat.id)!;
	};
	const pose = () => ackedCall(PRACTICE_PROBLEM_TOOL, "p1", { statement: "Show that…" });

	it("a posed practice problem is pending until a conclude or a dismissal", () => {
		assert.equal(listed("posed", "practice", pose()).pendingProblem, true);
		assert.equal(listed("concluded", "practice", [...pose(), ...ackedCall(PRACTICE_CONCLUDE_TOOL, "c1")]).pendingProblem, false);
		assert.equal(listed("dismissed", "practice", [...pose(), newProblemDismissedMarker("p1")]).pendingProblem, false);
		assert.equal(listed("posed", "practice", pose()).pendingQuestion, false);
	});

	it("a teaching session has no pending problem and the derived field is not persisted", () => {
		const row = listed("teaching", "teach", []);
		assert.equal(row.pendingProblem, false);
		assert.equal("pendingProblem" in chatStore.getChat(row.id)!, false);
	});

	it("an open canvas task in a teach session reads as waiting for input until it is closed", () => {
		const work = ackedCall("work", "w1", { instruction: "Sketch it" });
		assert.equal(listed("open task", "teach", work).pendingQuestion, true);
		assert.equal(listed("closed task", "teach", [...work, newWorkDismissedMarker("w1")]).pendingQuestion, false);
	});
});
