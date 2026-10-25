import { LEARNER_DUE_RING, LEARNER_STATE_ORDER, LEARNER_STATE_STYLES } from "@/src/core";

/**
 * The key for the "Show my knowledge" overlay: one dot per state in the
 * colour the canvas uses (src/core/learner-colors.ts is the single source),
 * plus the due ring. A single wrapping row of small text so it stays quiet
 * on a 390px phone; it never takes pointer events (the graph stays
 * draggable underneath).
 */
export function LearnerLegend({ className = "" }: { className?: string }) {
	return (
		<div
			data-testid="learner-legend"
			aria-label="Knowledge colours"
			className={`pointer-events-none flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-border/60 bg-card/70 px-2 py-1 text-[10px] leading-tight text-muted-foreground backdrop-blur ${className}`}
		>
			{LEARNER_STATE_ORDER.map((state) => {
				const style = LEARNER_STATE_STYLES[state];
				return (
					<span key={state} data-testid={`learner-legend-${state}`} className="flex items-center gap-1">
						<span aria-hidden className="inline-block size-2 rounded-full" style={{ backgroundColor: style.color }} />
						{style.label}
					</span>
				);
			})}
			<span data-testid="learner-legend-due" className="flex items-center gap-1">
				<span
					aria-hidden
					className="inline-block size-2.5 rounded-full border-[1.5px] bg-transparent"
					style={{ borderColor: LEARNER_DUE_RING.color }}
				/>
				{LEARNER_DUE_RING.label}
			</span>
		</div>
	);
}
