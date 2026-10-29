/**
 * The picker's "Recommended" group (cost-log-picker-notes, Task 7).
 * Provenance: TutorBench 2026-10-28, 7 tutors × 7 scenarios, Opus judges.
 * Opus/Sonnet were not benchmarked (owner rule: the Recommended badge there
 * is a pick, not a rank). Pure and browser-safe.
 */

export interface RecommendedModel {
	key: string;
	badge: "Recommended" | "Cheapest";
	line: string;
	/** Candidate catalog coordinates, preferred form first. */
	forms: ReadonlyArray<{ provider: string; id: string }>;
}

export const RECOMMENDED_MODELS: readonly RecommendedModel[] = [
	{
		key: "opus",
		badge: "Recommended",
		line: "best quality",
		forms: [
			{ provider: "anthropic", id: "claude-opus-5-5" },
			{ provider: "openrouter", id: "anthropic/claude-opus-5.5" },
		],
	},
	{
		key: "sonnet",
		badge: "Recommended",
		line: "strong and faster",
		forms: [
			{ provider: "anthropic", id: "claude-sonnet-5-5" },
			{ provider: "openrouter", id: "anthropic/claude-sonnet-5.5" },
		],
	},
	{
		key: "mimo-flash",
		badge: "Cheapest",
		line: "TutorBench #1 · ~$0.13/session",
		forms: [{ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" }],
	},
	{
		key: "deepseek-flash",
		badge: "Cheapest",
		line: "TutorBench #4 · ~$0.14/session · fastest",
		forms: [{ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" }],
	},
];

/** The recommended entries present in the catalog, in table order, each
 *  resolved to its first available form. */
export function recommendedFor<M extends { provider: string; id: string }>(
	models: readonly M[],
): Array<{ entry: RecommendedModel; model: M }> {
	const out: Array<{ entry: RecommendedModel; model: M }> = [];
	for (const entry of RECOMMENDED_MODELS) {
		for (const f of entry.forms) {
			const model = models.find((m) => m.provider === f.provider && m.id === f.id);
			if (model) {
				out.push({ entry, model });
				break;
			}
		}
	}
	return out;
}
