import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { newCompactionMarker, toLlmMessages, type LhMessage } from "../src/core/index.ts";

/**
 * HOTFIX 0.19.1: a STALE compaction marker kept inside the active cut's
 * tail must never render as user text between a tool call and its result
 * (the provider 400s: "unexpected tool_use_id found in tool_result blocks").
 */

const call = (id: string, callId: string): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "explain", arguments: {} }],
		timestamp: 1,
	}) as LhMessage;
const result = (id: string, callId: string): LhMessage =>
	({
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "explain",
		content: [{ type: "text", text: "answer" }],
		isError: false,
		timestamp: 1,
	}) as LhMessage;
const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 }) as LhMessage;
const details = (firstKeptMessageId: string) => ({ firstKeptMessageId, tokensBefore: 1, at: "fixture" });

/** Every toolCall is immediately followed by its toolResults; no orphan results (consecutive user turns are legal: providers merge them). */
function assertWireValid(out: readonly { role: string; content?: unknown }[]): void {
	for (let i = 0; i < out.length; i++) {
		const m = out[i]!;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const ids = (m.content as { type: string; id?: string }[]).filter((b) => b.type === "toolCall").map((b) => b.id!);
			if (ids.length === 0) continue;
			const got = new Set<string>();
			let j = i + 1;
			while (out[j]?.role === "toolResult") got.add((out[j++] as unknown as { toolCallId: string }).toolCallId);
			for (const id of ids) assert.ok(got.has(id), `tool call ${id} not followed by its result`);
		}
		if (m.role === "toolResult") {
			const prev = (() => {
				let k = i - 1;
				while (k >= 0 && out[k]!.role === "toolResult") k--;
				return out[k];
			})();
			assert.equal(prev?.role, "assistant", "toolResult must follow an assistant tool call");
		}
	}
}

describe("stale compaction markers", () => {
	it("stale compaction marker inside a tool pair is skipped", () => {
		const stale = newCompactionMarker("STALE SUMMARY", details("u0"));
		const active = newCompactionMarker("ACTIVE SUMMARY", details("u0"));
		const messages: LhMessage[] = [
			user("u0", "hi"),
			call("a1", "c1"),
			stale,
			result("r1", "c1"),
			user("u1", "next"),
			active,
		];
		const out = toLlmMessages(messages);
		const callIdx = out.findIndex((m) => m.role === "assistant");
		assert.equal(out[callIdx + 1]?.role, "toolResult", "nothing between the call and its result");
		const text = JSON.stringify(out);
		assert.equal(text.split("ACTIVE SUMMARY").length - 1, 1, "active summary exactly once");
		assert.equal(text.includes("STALE SUMMARY"), false);
		assert.equal(out[0]?.role, "user");
		assert.ok(JSON.stringify(out[0]).includes("ACTIVE SUMMARY"), "active summary is the head");
		assertWireValid(out);
	});

	it("unresolvable active cut renders its content as the head, not in place", () => {
		const active = newCompactionMarker("ACTIVE SUMMARY", details("missing"));
		const messages: LhMessage[] = [user("u0", "hi"), call("a1", "c1"), active, result("r1", "c1")];
		const out = toLlmMessages(messages);
		assert.ok(JSON.stringify(out[0]).includes("ACTIVE SUMMARY"));
		assert.equal(JSON.stringify(out).split("ACTIVE SUMMARY").length - 1, 1);
		assertWireValid(out);
	});

	it("wedged real record becomes valid", () => {
		const { messages } = JSON.parse(
			readFileSync(new URL("./fixtures/regressions/compaction-wedge.json", import.meta.url), "utf8"),
		) as { messages: LhMessage[] };
		const out = toLlmMessages(messages);
		assertWireValid(out);
		const markers = out.filter((m) => JSON.stringify(m).includes("compact"));
		assert.ok(markers.length <= 1, "at most the head mentions the compaction");
	});
});
