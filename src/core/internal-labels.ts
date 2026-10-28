/**
 * INTERNAL LABELS NEVER REACH THE LEARNER (owner, 2026-10-28). The hint
 * ladder's rung numbers and names are the tutor's own scale; models still
 * leak them into prose ("**Hint 1 (Rang 1 — Muster benennen):**",
 * "(R1: Das ist eine Bausteinkonstruktion…)"). The prompt forbids it, and
 * this pure strip is the deterministic backstop at the READ seams
 * (projectView for what he reads, toLlmMessages for the model's own history,
 * hintsFor and the session export). The persisted record stays raw.
 * Browser-safe: pure string code.
 *
 * SCOPED (final fix wave, 2026-10-28): the mid-text rule (b) also eats real
 * course content ("die Widerstände (R1: 5 Ω, R2: 10 Ω)"), so it runs only on
 * a reply to a hint request or a submission (isHintScopedInput), where a
 * leaked label is the likely reading. The leading header (a) is only ever a
 * label and is stripped everywhere.
 */

// A parenthetical body: anything but parens, or one nested "(…)" pair, so
// "(R1: f(x) = 2)" goes whole instead of leaving " = 2)".
const BODY = String.raw`(?:[^()]|\([^()]*\))*`;

// (a) A leading header: optional "**", Hint/Tipp/Hinweis + number, optional
// "**" (the header may close before its label: "**Hint 1** (R1): look"), a
// parenthetical that opens with a rung label, optional ".", ":" and "**",
// then the whitespace/newlines that separated it from the real text.
const RUNG_HEADER = new RegExp(
	String.raw`^\s*(?:\*\*)?(?:[Hh]int|[Tt]ipp|[Hh]inweis)\s*\d+\s*(?:\*\*)?\s*\(\s*(?:R[0-5]\b|[Rr]ung|[Rr]ang|[Ss]tufe)${BODY}\)\s*[.:]?\s*(?:\*\*)?\s*:?\s*`,
);

// (b) An inline label after whitespace: "(R1: …)" (the colon keeps a bare
// "(R1)" such as a register name intact), or a named rung: "rung/Rang/Stufe"
// + number + separator + name ("(Rang 1 — Muster benennen)"; "rung" alone
// may skip the number: "(rung: name the pattern)"). "(Rang 2)" and
// "(Stufe 2 der Chomsky-Hierarchie)" have no separator and stay.
const INLINE_LABEL = new RegExp(
	String.raw`\s+\((?:R[0-5]:|(?:(?:[Rr]ung|[Rr]ang|[Ss]tufe)\s*\d+|[Rr]ung)\s*(?::|—|–|\s-\s)\s*[^\s()])${BODY}\)`,
	"g",
);

/** The input kinds whose reply may carry a mid-text rung label: a hint
 *  request, or a submission (canvas work, practice thinking) being coached. */
const HINT_SCOPED_INPUTS: readonly string[] = ["hint-request", "work-submission", "practice-thinking"];

/** Is this record message an input whose reply is hint-scoped? Callers walk
 *  the record in order and re-evaluate at every input boundary. */
export function isHintScopedInput(message: unknown): boolean {
	const m = message as { role?: unknown; customType?: unknown } | null;
	return m?.role === "custom" && HINT_SCOPED_INPUTS.includes(m.customType as string);
}

/** Remove internal hint-ladder labels from learner-facing prose. `hintReply`
 *  = the text answers a hint request or a submission: only then does the
 *  mid-text rule run. Pure, idempotent. */
export function stripInternalLabels(text: string, hintReply = false): string {
	const out = text.replace(RUNG_HEADER, "");
	return hintReply ? out.replace(INLINE_LABEL, "") : out;
}
