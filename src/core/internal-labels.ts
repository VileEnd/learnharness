/**
 * INTERNAL LABELS NEVER REACH THE LEARNER (owner, 2026-10-28). The hint
 * ladder's rung numbers and names are the tutor's own scale; models still
 * leak them into prose ("**Hint 1 (Rang 1 — Muster benennen):**",
 * "(R1: Das ist eine Bausteinkonstruktion…)"). The prompt forbids it, and
 * this pure strip is the deterministic backstop at the two READ seams
 * (projectView for what he reads, toLlmMessages for the model's own history).
 * The persisted record stays raw. Browser-safe: pure string code.
 */

// (a) A leading header: optional "**", Hint/Tipp/Hinweis + number, a
// parenthetical that opens with a rung label, optional ".", ":" and "**",
// then the whitespace/newlines that separated it from the real text.
const RUNG_HEADER =
	/^\s*(?:\*\*)?(?:[Hh]int|[Tt]ipp|[Hh]inweis)\s*\d+\s*\(\s*(?:R[0-5]\b|[Rr]ung|[Rr]ang|[Ss]tufe)[^)]*\)\s*[.:]?\s*(?:\*\*)?\s*:?\s*/;

// (b) An inline label after whitespace: "(R1: …)" (the colon keeps a bare
// "(R1)" such as a register name intact) or "(rung/Rang/Stufe <n> …)".
const INLINE_LABEL = /\s+\((?:R[0-5]:|(?:[Rr]ung|[Rr]ang|[Ss]tufe)\s*\d)[^)]*\)/g;

/** Remove internal hint-ladder labels from learner-facing prose. Pure, idempotent. */
export function stripInternalLabels(text: string): string {
	return text.replace(RUNG_HEADER, "").replace(INLINE_LABEL, "");
}
