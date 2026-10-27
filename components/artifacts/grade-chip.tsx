"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The quiet chip for a recorded free-recall grade ("counted as: partly"):
 * the learner sees how his answer counted. It renders from the grade call's
 * INPUT; a refused call (output-error) or a malformed input renders nothing,
 * since only a recorded grade counts. The agent's one-line note rides the
 * hover title. A grade that closes a canvas task (work/sketch) also reveals
 * the committed `correctAnswer` (joined onto the part by projectView).
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
	const reveal = typeof part.reveal === "string" && part.reveal.trim().length > 0 ? part.reveal : undefined;
	return (
		<div data-testid="grade-chip" className="my-1 select-none">
			<span
				title={note}
				className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
			>
				counted as: {label}
			</span>
			{reveal && (
				<div data-testid="grade-reveal" className="mt-2 select-text rounded-xl border bg-card p-3">
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">A good solution</div>
					<div className="lh-prose text-[15px]">
						<ToolContentResponse>{reveal}</ToolContentResponse>
					</div>
				</div>
			)}
		</div>
	);
}
