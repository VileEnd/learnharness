"use client";

import { annotationMarkPlace, parseAnnotateInput, type ArtifactPartProps } from "@/src/core";

/**
 * The quiet record of the teacher's `annotate` call: one line per mark ("circle  o2 - label"). The ink
 * itself is drawn over the drawing (thumbnail and canvas workspace); a refused call renders nothing,
 * since only a call that happened leaves marks (annotationsOf folds the same way). The input is read
 * through parseAnnotateInput: the record keeps RAW arguments, so a `marks` the model sent as a JSON
 * string heals here exactly as it did at the tool boundary (the tool-parts law).
 */
export function AnnotateCard({ part }: ArtifactPartProps) {
	if (part.state === "output-error") return null;
	const input = parseAnnotateInput(part.input);
	if (!input) return null;
	return (
		<div data-testid="annotate-card" className="my-1 select-none rounded-lg border bg-card px-3 py-2 text-sm">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Marked on your drawing</div>
			<ul className="space-y-0.5">
				{input.marks.map((m, i) => (
					<li key={i} className="text-muted-foreground">
						<span className="font-medium text-foreground">{m.kind}</span> {annotationMarkPlace(m)}
						{m.label ? <span> {"—"} {m.label}</span> : null}
					</li>
				))}
			</ul>
		</div>
	);
}
