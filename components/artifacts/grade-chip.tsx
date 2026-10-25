"use client";

import type { ArtifactPartProps } from "@/src/core";

/**
 * The quiet chip for a recorded free-recall grade ("counted as: partly"):
 * the learner sees how his answer counted. It renders from the grade call's
 * INPUT; a refused call (output-error) or a malformed input renders nothing,
 * since only a recorded grade counts. The agent's one-line note rides the
 * hover title.
 */
const LABEL: Record<string, string> = {
	correct: "correct",
	partly: "partly",
	wrong: "wrong",
	dontKnow: "don't know",
};

export function GradeChip({ part }: ArtifactPartProps) {
	if (part.state === "output-error") return null;
	const input = part.input as { grade?: unknown; note?: unknown } | undefined;
	const label = typeof input?.grade === "string" ? LABEL[input.grade] : undefined;
	if (!label) return null;
	const note = typeof input?.note === "string" && input.note.length > 0 ? input.note : undefined;
	return (
		<div data-testid="grade-chip" className="my-1 select-none">
			<span
				title={note}
				className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
			>
				counted as: {label}
			</span>
		</div>
	);
}
