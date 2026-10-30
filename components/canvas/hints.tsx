"use client";

/**
 * HINTS INSIDE THE CANVAS: the replies to this task's hint requests, derived from the record (hintsFor), so
 * the learner reads and re-reads them without leaving the workspace. HintStrip shows the newest one above
 * "Your thinking" (collapsible, height-capped so the drawing surface keeps its room); HintsButton is the
 * toolbar's "i" with a count badge and a panel listing every hint of the task in order. Nothing renders
 * while the task has had no hint request.
 */

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, InfoIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { cn } from "@/lib/utils";

export interface HintItem {
	requestId: string;
	text: string | null;
}

/** The hints that have arrived (numbered by request order, so "Hint 2" stays Hint 2). */
export function arrivedHints(hints: readonly HintItem[]): { n: number; text: string }[] {
	return hints.flatMap((h, i) => (h.text !== null ? [{ n: i + 1, text: h.text }] : []));
}

/** A hint is pending while the newest request has no text yet and a turn is still running. */
export function hintPending(hints: readonly HintItem[], turnBusy: boolean): boolean {
	return turnBusy && hints.length > 0 && hints[hints.length - 1]!.text === null;
}

export function HintStrip({ hints, turnBusy }: { hints: readonly HintItem[]; turnBusy: boolean }) {
	const [open, setOpen] = useState(true);
	const arrived = arrivedHints(hints);
	const pending = hintPending(hints, turnBusy);
	if (arrived.length === 0 && !pending) return null;
	const newest = arrived[arrived.length - 1];
	const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
	return (
		<div data-testid="canvas-hint-strip" className="mt-2 shrink-0 rounded-[10px] border border-border/70 bg-card">
			<button type="button" aria-expanded={open} data-testid="canvas-hint-strip-toggle" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<Chevron className="size-3.5" />
				{pending ? (
					<span className="flex items-center gap-2 normal-case">
						<BrailleSpinner label="Getting a hint" />
						<Shimmer duration={1} className="text-xs">
							Getting a hint…
						</Shimmer>
					</span>
				) : (
					<span>Hint {newest?.n}</span>
				)}
			</button>
			{open && newest && !pending && (
				<div data-testid="canvas-hint-text" className="max-h-[min(7rem,16dvh)] overflow-y-auto px-2.5 pb-2 text-sm">
					<ToolContentResponse>{newest.text}</ToolContentResponse>
				</div>
			)}
		</div>
	);
}

/** The toolbar "i": a count badge and a panel of every arrived hint, oldest first. */
export function HintsButton({ hints, open, onToggle }: { hints: readonly HintItem[]; open: boolean; onToggle: () => void }) {
	if (hints.length === 0) return null;
	const arrived = arrivedHints(hints);
	return (
		<div className="relative">
			<button type="button" title="Hints so far" aria-label={`Hints so far (${hints.length})`} aria-expanded={open} data-testid="canvas-hints-button" onClick={onToggle} className={cn("relative rounded-md p-1.5 pointer-coarse:p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground", open && "bg-accent text-foreground")}>
				<InfoIcon className="size-4" />
				<span data-testid="canvas-hints-count" className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-4 text-primary-foreground">
					{hints.length}
				</span>
			</button>
			{open && (
				<div role="dialog" aria-label="Hints so far" data-testid="canvas-hints-panel" className="absolute right-0 top-full z-30 mt-1 max-h-72 w-[min(26rem,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-lg border bg-popover p-3 text-sm shadow-lg">
					{arrived.length === 0 && <div className="text-xs text-muted-foreground">No hint has arrived yet.</div>}
					{arrived.map((h) => (
						<div key={h.n}>
							<div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Hint {h.n}</div>
							<ToolContentResponse>{h.text}</ToolContentResponse>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
