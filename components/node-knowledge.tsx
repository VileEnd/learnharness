import { EVIDENCE_VERBS, LEARNER_STATE_STYLES, type ConceptState } from "@/src/core";

/**
 * The detail card's "what I know about this" block: the state line, the last
 * evidence lines (at most 3, newest first, each with its session title), the
 * next review date and any open confusions. Pure: the snapshot's ConceptState
 * and the sessions map arrive as props. Renders nothing when the concept has
 * no state at all (no learner data loaded yet).
 */

const day = (iso: string) => iso.slice(0, 10);

export function NodeKnowledge({
	state,
	sessions,
}: {
	state: ConceptState | undefined;
	/** chat id -> session title (the graph snapshot's sessions map). */
	sessions: Record<string, string>;
}) {
	if (!state) return null;
	const clean = `${state.streak} clean ${state.streak === 1 ? "session" : "sessions"} in a row`;
	const label = LEARNER_STATE_STYLES[state.state].label;
	const stateText = state.state === "learning" || state.state === "solid" ? `${label} - ${clean}` : label;
	return (
		<div data-testid="node-knowledge" className="mt-3 flex flex-col gap-1 border-t pt-3">
			<div className="text-xs text-muted-foreground">My knowledge</div>
			<div data-testid="node-knowledge-state" className="flex items-center gap-1.5 text-xs">
				<span
					aria-hidden
					className="inline-block size-2 shrink-0 rounded-full"
					style={{ backgroundColor: LEARNER_STATE_STYLES[state.state].color }}
				/>
				<span>
					{stateText}
					{state.due ? " · due for review" : ""}
				</span>
			</div>
			{state.weakFoundation && (
				<div data-testid="node-knowledge-foundation" className="text-xs text-muted-foreground">
					A premise is shaky or due.
				</div>
			)}
			{state.last.slice(0, 3).map((e, i) => {
				const title = sessions[e.chatId];
				return (
					<div key={`${e.toolCallId}-${i}`} data-testid="node-knowledge-evidence" className="text-xs leading-relaxed text-muted-foreground">
						{EVIDENCE_VERBS[e.raw] ?? e.raw} {day(e.at)} in {title ? `"${title}"` : "a session"}
						{e.note ? `: ${e.note}` : ""}
					</div>
				);
			})}
			{state.nextReviewAt && (
				<div data-testid="node-knowledge-next" className="text-xs text-muted-foreground">
					Next review {day(state.nextReviewAt)}
				</div>
			)}
			{state.openMisconceptions.length > 0 && (
				<div data-testid="node-knowledge-confusions" className="mt-1 flex flex-col gap-0.5 text-xs">
					<div className="text-muted-foreground">Open confusions</div>
					{state.openMisconceptions.map((m) => (
						<div key={m.term} className="leading-relaxed">
							{m.term}
							{m.instead ? ` → ${m.instead}` : ""}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
