import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripInternalLabels } from "../src/core/internal-labels.ts";
import { hintsFor, newHintRequest, toLlmMessages } from "../src/core/native-messages.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

const cases: Array<[string, string]> = [
	["**Hint 1 (rung: name the pattern).**\n\nLook only at the squared part.", "Look only at the squared part."],
	["**Hint 1 (Rang 1 — Muster benennen):**\n\nVerschieben tut nicht", "Verschieben tut nicht"],
	["**Hint 1 (R1):** The equation is a recipe", "The equation is a recipe"],
	["welche Regel liegt zugrunde? (R1: Das ist eine Bausteinkonstruktion, kein freies Aufzählen.)", "welche Regel liegt zugrunde?"],
];

describe("stripInternalLabels", () => {
	it("strips rung headers and labels", () => {
		for (const [i, o] of cases) assert.equal(stripInternalLabels(i), o);
	});
	it("keeps ordinary content", () => {
		for (const s of ["**Hint 1:** Forget the rules", "register (R1) holds the sum", "Let R1 = 5 ohm", "Stufe 2 der Treppe"]) {
			assert.equal(stripInternalLabels(s), s);
		}
	});
	it("is idempotent", () => {
		for (const [i] of cases) assert.equal(stripInternalLabels(stripInternalLabels(i)), stripInternalLabels(i));
	});
});

const assistant = (text: string) =>
	({ id: "a1", role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 }) as unknown as LhMessage;

describe("read seams", () => {
	it("projectView shows the stripped text", () => {
		const view = projectView([assistant("**Hint 1 (R1):** Look")]);
		const part = view[0]!.parts.find((p) => p.type === "text") as { text: string };
		assert.equal(part.text, "Look");
	});
	it("toLlmMessages hands the model the stripped text, record untouched", () => {
		const m = assistant("**Hint 1 (R1):** Look");
		const wire = toLlmMessages([m] as never);
		assert.equal((wire[0] as { content: Array<{ text: string }> }).content[0]!.text, "Look");
		assert.equal((m as unknown as { content: Array<{ text: string }> }).content[0]!.text, "**Hint 1 (R1):** Look");
	});
});

const user = (text: string) => ({ id: "u1", role: "user", content: [{ type: "text", text }], timestamp: 0 }) as unknown as LhMessage;

describe("other learner-facing readers and empty results", () => {
	it("hintsFor returns the stripped hint text", () => {
		const msgs = [newHintRequest("w1", 1), assistant("**Hint 1 (R1):** x")];
		assert.equal(hintsFor(msgs, "w1")[0]!.text, "x");
	});
	it("a label-only message projects no empty text part", () => {
		const view = projectView([assistant("**Hint 1 (R1):**")]);
		assert.equal(view[0]?.parts.filter((p) => p.type === "text").length ?? 0, 0);
	});
	it("toLlmMessages drops a label-only text block, keeps the rest", () => {
		const m = { ...assistant("x"), content: [{ type: "text", text: "**Hint 1 (R1):**" }, { type: "text", text: "kept" }] } as unknown as LhMessage;
		const wire = toLlmMessages([m] as never);
		assert.deepEqual((wire[0] as { content: unknown[] }).content, [{ type: "text", text: "kept" }]);
	});
	it("toLlmMessages keeps the original blocks when stripping would empty the message", () => {
		const wire = toLlmMessages([assistant("**Hint 1 (R1):**")] as never);
		assert.equal((wire[0] as { content: Array<{ text: string }> }).content[0]!.text, "**Hint 1 (R1):**");
	});
	it("the session export strips teacher prose", () => {
		const md = sessionMarkdown([user("hi"), assistant("**Hint 1 (R1):** Look")]);
		assert.ok(md.includes("Look") && !md.includes("Hint 1"));
	});
	// KNOWN FALSE POSITIVE of rule (b), accepted trade-off: a real "(R1: …)" aside is indistinguishable from a leaked label.
	it("strips a genuine '(R1: …)' aside (accepted)", () => {
		assert.equal(stripInternalLabels("the resistor (R1: 5 Ω)"), "the resistor");
	});
});
