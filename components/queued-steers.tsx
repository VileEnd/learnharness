/**
 * THE QUEUED-STEER INDICATOR (owner spec 2026-10-03): steers sent but not
 * yet drained render as quiet one-liners ABOVE the composer shell —
 * right-aligned to where the shell's corner rounding starts, truncated
 * with an ellipsis, no background, no container, roughly half opacity.
 * Visible but very quiet; layout tunable later.
 *
 * A line dies the moment its card lands in the transcript: the drain's
 * verbatim message events upsert the real user card by the client-minted
 * id, and visibleQueuedSteers (session-core, pure) filters the queue
 * against the message ids. A steer parked server-side (stranded behind a
 * question) keeps its line — an honest "waiting for the next run".
 */
import { citationsToLabels } from "@/src/core";

export interface QueuedSteerLine {
	id: string;
	text: string;
}

/** The pure body (SSR-pinnable): one right-aligned truncated line per
 *  queued steer, stacked. */
export function QueuedSteersBody({ steers }: { steers: QueuedSteerLine[] }) {
	if (steers.length === 0) return null;
	return (
		<div className="flex flex-col items-end gap-0.5 pb-1 pr-4" data-testid="queued-steers">
			{steers.map((s) => {
				// A tutor quote reads as its short label, never as its raw link.
				const line = citationsToLabels(s.text);
				return (
					<span
						key={s.id}
						title={line}
						className="block max-w-[240px] truncate font-ui text-[11px] text-muted-foreground/60"
					>
						{line}
					</span>
				);
			})}
		</div>
	);
}
