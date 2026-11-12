import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectView, shareView, type LhMessage, type LhViewMessage } from "../src/core/index.ts";

const textOf = (m: LhViewMessage | undefined) => m?.parts.find((p) => p.type === "text")?.text;
const usage = { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 };
const user = (id: string, text: string) => ({ id, role: "user", content: text, timestamp: 1 }) as unknown as LhMessage;
const assistant = (id: string, text: string) =>
	({ id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage, timestamp: 1, provider: "p", model: "m" }) as unknown as LhMessage;

describe("shareView", () => {
	const settled = [user("u1", "q1"), assistant("a1", "one"), user("u2", "q2"), assistant("a2", "two")];

	it("keeps settled view messages by identity when only the tail changes", () => {
		const first = shareView([], projectView([...settled, user("u3", "q3"), assistant("live", "par")]));
		const second = shareView(first, projectView([...settled, user("u3", "q3"), assistant("live", "partial")]));
		assert.equal(second.length, first.length);
		for (let i = 0; i < first.length - 1; i++) assert.equal(second[i], first[i], `message ${i} keeps its identity`);
		assert.notEqual(second.at(-1), first.at(-1));
		assert.equal(textOf(second.at(-1)), "partial");
	});

	it("returns the previous list itself when nothing changed", () => {
		const first = shareView([], projectView(settled));
		assert.equal(shareView(first, projectView(settled)), first);
	});

	it("takes the new projection when a settled message really changed", () => {
		const first = shareView([], projectView(settled));
		const edited = [settled[0]!, assistant("a1", "ONE"), ...settled.slice(2)];
		const next = shareView(first, projectView(edited));
		assert.notEqual(next, first);
		assert.notEqual(next[1], first[1]);
		assert.equal(textOf(next[1]), "ONE");
		assert.equal(next[0], first[0]);
	});
});
