"use client";

import type { AnnotationMark, AnnotationTarget, ArtifactPartProps } from "@/src/core";

/**
 * The quiet record of the teacher's `annotate` call: one line per mark ("circle  o2 - label"). The ink
 * itself is drawn over the drawing (thumbnail and canvas workspace); a refused call renders nothing,
 * since only a call that happened leaves marks (annotationsOf folds the same way).
 */
function where(t: unknown): string {
	const x = (t ?? {}) as Partial<Record<"object" | "cell" | "cells", unknown>>;
	const v = x.object ?? x.cell ?? x.cells;
	return typeof v === "string" ? v : "?";
}

export function AnnotateCard({ part }: ArtifactPartProps) {
	if (part.state === "output-error") return null;
	const input = part.input as { marks?: unknown } | undefined;
	if (!Array.isArray(input?.marks) || input.marks.length === 0) return null;
	const marks = input.marks as AnnotationMark[];
	return (
		<div data-testid="annotate-card" className="my-1 select-none rounded-lg border bg-card px-3 py-2 text-sm">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Marked on your drawing</div>
			<ul className="space-y-0.5">
				{marks.map((m, i) => {
					const at = m.kind === "arrow" ? `${where(m.from)} → ${where(m.to)}` : where((m as { target?: AnnotationTarget }).target);
					return (
						<li key={i} className="text-muted-foreground">
							<span className="font-medium text-foreground">{m.kind}</span> {at}
							{m.label ? <span> {"—"} {m.label}</span> : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
