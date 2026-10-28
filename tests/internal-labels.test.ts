import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripInternalLabels } from "../src/core/internal-labels.ts";
import { hintsFor, newHintRequest, toLlmMessages } from "../src/core/native-messages.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

// Rule (a), the leading "Hint n (…)" header: stripped everywhere.
const headerCases: Array<[string, string]> = [
	["**Hint 1 (rung: name the pattern).**\n\nLook only at the squared part.", "Look only at the squared part."],
	["**Hint 1 (Rang 1 — Muster benennen):**\n\nVerschieben tut nicht", "Verschieben tut nicht"],
	["**Hint 1 (R1):** The equation is a recipe", "The equation is a recipe"],
	["**Hint 1** (R1): look", "look"],
];
// Rule (b), the mid-text label: stripped only in a reply to a hint request or a submission.
const inlineCases: Array<[string, string]> = [
	["welche Regel liegt zugrunde? (R1: Das ist eine Bausteinkonstruktion, kein freies Aufzählen.)", "welche Regel liegt zugrunde?"],
	["Schau hin (Rang 1 — Muster benennen) und dann weiter.", "Schau hin und dann weiter."],
	["look (rung: name the pattern) first", "look first"],
	["look (R1: f(x) = 2) here", "look here"],
];
// Real course content: survives in every scope.
const content = [
	"**Hint 1:** Forget the rules",
	"register (R1) holds the sum",
	"Let R1 = 5 ohm",
	"Stufe 2 der Treppe",
	"Die Matrix A (Rang 2) ist singulär.",
	"Typ-2-Grammatiken (Stufe 2 der Chomsky-Hierarchie) sind kontextfrei.",
];

describe("stripInternalLabels", () => {
	it("strips a rung header in every scope", () => {
		for (const [i, o] of headerCases) {
			assert.equal(stripInternalLabels(i), o);
			assert.equal(stripInternalLabels(i, true), o);
		}
	});
	it("strips a mid-text label only in a hint or submission reply", () => {
		for (const [i, o] of inlineCases) {
			assert.equal(stripInternalLabels(i, true), o);
			assert.equal(stripInternalLabels(i), i);
		}
	});
	it("keeps ordinary content", () => {
		for (const s of content) {
			assert.equal(stripInternalLabels(s), s);
			assert.equal(stripInternalLabels(s, true), s);
		}
	});
	it("keeps a '(R1: …)' aside outside a hint or submission reply", () => {
		const s = "Die Widerstände (R1: 5 Ω, R2: 10 Ω) liegen in Reihe.";
		assert.equal(stripInternalLabels(s), s);
	});
	it("is idempotent", () => {
		for (const [i] of [...headerCases, ...inlineCases]) {
			assert.equal(stripInternalLabels(stripInternalLabels(i, true), true), stripInternalLabels(i, true));
		}
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
	it("the session export emits no empty Teacher section for a label-only block", () => {
		const md = sessionMarkdown([user("hi"), assistant("**Hint 1 (R1):**")]);
		assert.ok(!md.includes("### Teacher"), md);
	});
	it("the session export strips teacher prose", () => {
		const md = sessionMarkdown([user("hi"), assistant("**Hint 1 (R1):** Look")]);
		assert.ok(md.includes("Look") && !md.includes("Hint 1"));
	});
	// KNOWN FALSE POSITIVE of rule (b), accepted trade-off: inside a hint or
	// submission reply a real "(R1: …)" aside is indistinguishable from a leaked label.
	it("strips a genuine '(R1: …)' aside only in a hint reply (accepted)", () => {
		assert.equal(stripInternalLabels("the resistor (R1: 5 Ω)", true), "the resistor");
	});
});

const marker = (customType: string, id = "k1") =>
	({ id, role: "custom", customType, content: "x", display: true, details: { callId: "w1" }, timestamp: 0 }) as unknown as LhMessage;
const AS_ASIDE = "Die Widerstände (R1: 5 Ω, R2: 10 Ω) liegen in Reihe.";
const AS_LABEL = "Schau hin (R1: Muster benennen) und weiter.";
const viewText = (msgs: LhMessage[]) =>
	projectView(msgs).filter((v) => v.role === "assistant").flatMap((v) => v.parts).filter((p) => p.type === "text").map((p) => p.text).join("|");
const wireText = (msgs: LhMessage[]) =>
	(toLlmMessages(msgs as never).at(-1) as { content: Array<{ text: string }> }).content[0]!.text;

describe("the mid-text rule is scoped to hint and submission replies", () => {
	for (const kind of ["hint-request", "work-submission", "practice-thinking"]) {
		it(`strips a label in the reply to a ${kind}`, () => {
			const msgs = [marker(kind), assistant(AS_LABEL)];
			assert.equal(viewText(msgs), "Schau hin und weiter.");
			assert.equal(wireText(msgs), "Schau hin und weiter.");
			assert.ok(sessionMarkdown(msgs).includes("Schau hin und weiter."));
		});
	}
	it("keeps the same text in the reply to an ordinary user message", () => {
		const msgs = [user("hi"), assistant(AS_ASIDE)];
		assert.equal(viewText(msgs), AS_ASIDE);
		assert.equal(wireText(msgs), AS_ASIDE);
		assert.ok(sessionMarkdown(msgs).includes(AS_ASIDE));
	});
	it("a later user message ends the hint scope", () => {
		const msgs = [marker("hint-request"), assistant("ok"), user("and now?"), { ...assistant(AS_ASIDE), id: "a2" } as LhMessage];
		assert.ok(viewText(msgs).endsWith(AS_ASIDE));
		assert.equal(wireText(msgs), AS_ASIDE);
	});
});
