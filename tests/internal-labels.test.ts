import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripInternalLabels } from "../src/core/internal-labels.ts";
import { toLlmMessages } from "../src/core/native-messages.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

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
