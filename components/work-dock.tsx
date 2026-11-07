"use client";

import { useCallback, useRef, useState } from "react";
import { LightbulbIcon, PenLineIcon, PlayIcon, ChevronRightIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { enterSends, useEnterSubmits } from "@/components/enter-submits";
import { useAutoGrow, useCoarsePointer } from "@/components/use-coarse-pointer";
import { PhotoControl, usePhotoAttachment } from "@/components/canvas/photo-attachment";

/**
 * The work dock (canvas tasks, PR 2): while a canvas task (work/sketch) is open and its workspace is
 * minimised, this replaces the composer. It is a MINIMISED bar: the task, "Open canvas" (tablet and
 * computer only), and a text field, so a typed or dictated answer is a valid submission on its own
 * (decision 12: one lane while a task is open). On a phone "Open canvas" is gone: the field is the answer
 * surface, plus "Add photo" (a photo of the learner's work, sent as a one-image drawing with the typed answer
 * by Submit; canvas/photo-prepare.ts). A teach-phase check arrives behind the reveal bar, like a quiz check.
 *
 * `active` is the dictation claim: false while the workspace is open (its own field holds the claim).
 */

export interface WorkDockProps {
	chatId: string;
	/** The task's tool-call id (hint and dismissal target it). */
	callId: string;
	question: string;
	/** Does the dock own the dictation target right now (workspace closed)? */
	active: boolean;
	/** A teach-phase check starts behind the reveal bar. */
	requiresReveal: boolean;
	canvasCapable: boolean;
	onOpenCanvas?: () => void;
	/** The answer: the typed text, plus the drawingId of a photo sent from the phone (a canvas drawing rides the
	 *  workspace's own Submit). */
	onSubmit: (text: string, drawingId?: string) => void;
	onHint?: () => void;
	/** Offer the dismissal (the host opens the confirm). */
	onDismiss: () => void;
	onEscape?: () => void;
	compactionRunning?: boolean;
}

export const PHONE_CANVAS_HINT = "Draw on a tablet or computer";

export function WorkDock({
	chatId,
	callId,
	question,
	active,
	requiresReveal,
	canvasCapable,
	onOpenCanvas,
	onSubmit,
	onHint,
	onDismiss,
	onEscape,
	compactionRunning = false,
}: WorkDockProps) {
	const [revealed, setRevealed] = useState(false);
	const [thinking, setThinking] = useState("");
	const thinkingRef = useRef("");
	const coarse = useCoarsePointer();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(fieldRef, thinking);
	// A phone has no canvas: the photo stands in for the drawing (nothing is sent until Submit).
	const photo = usePhotoAttachment(chatId);
	const photoReady = !canvasCapable && photo.ready;

	useDictationTarget(
		useCallback((t: string) => {
			const v = joinDictation(thinkingRef.current, t);
			thinkingRef.current = v;
			setThinking(v);
		}, []),
		active && (!requiresReveal || revealed),
	);

	const canSubmit = !compactionRunning && !photo.busy && (thinking.trim().length > 0 || photoReady);
	const submit = () => {
		if (!active || !canSubmit) return;
		const text = thinkingRef.current.trim();
		if (!photoReady) {
			thinkingRef.current = "";
			setThinking("");
			onSubmit(text);
			return;
		}
		void photo.send().then((drawingId) => {
			if (drawingId === null) return; // the error shows under the photo; the text and the photo stay
			if (thinkingRef.current.trim() === text) {
				thinkingRef.current = "";
				setThinking("");
			}
			photo.clear();
			onSubmit(text, drawingId);
		});
	};
	// Enter submits from anywhere (typing surfaces excluded) - only while this dock owns the band.
	useEnterSubmits(submit);

	if (requiresReveal && !revealed) {
		return (
			<button
				type="button"
				data-testid="work-dock-reveal"
				onClick={() => setRevealed(true)}
				className="dock-variant flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
					<PlayIcon className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium">Check your understanding</span>
					<span className="block truncate text-xs text-muted-foreground">A canvas task is waiting</span>
				</span>
				<span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
					Open <ChevronRightIcon className="size-3.5" />
				</span>
			</button>
		);
	}

	return (
		<div data-testid="work-dock" data-work={callId} data-chat={chatId}>
			<div data-dock-scroll-area="" className="max-h-[var(--dock-max-h,40vh)] overflow-y-auto px-4 pt-3 pb-2">
				<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Canvas task
					<button
						type="button"
						data-testid="work-dismiss"
						onClick={onDismiss}
						className="ml-auto rounded px-1.5 py-0.5 normal-case tracking-normal text-muted-foreground/70 transition-colors hover:text-foreground"
					>
						Dismiss
					</button>
				</div>
				<div className="lh-prose text-[15px]">
					<ToolContentResponse>{question}</ToolContentResponse>
				</div>
				<div className="mt-2">
					{canvasCapable ? (
						<Button type="button" variant="outline" data-testid="open-canvas" disabled={compactionRunning} onClick={onOpenCanvas} className="h-9 gap-1.5 rounded-[6px] px-3 text-sm">
							<PenLineIcon className="size-4" /> Open canvas
						</Button>
					) : (
						<div className="flex flex-col gap-2">
							<span data-testid="canvas-phone-hint" className="text-xs text-muted-foreground">
								{PHONE_CANVAS_HINT}
							</span>
							<PhotoControl photo={photo} disabled={compactionRunning} />
						</div>
					)}
				</div>
			</div>
			<div data-testid="work-thinking-field" className="m-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
				<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Your thinking</div>
				<textarea
					ref={fieldRef}
					value={thinking}
					onChange={(e) => {
						thinkingRef.current = e.target.value;
						setThinking(e.target.value);
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape" && onEscape) {
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						if (enterSends(e, coarse)) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder={canvasCapable ? "Answer here, or open the canvas." : "Write your answer here."}
					enterKeyHint={coarse ? "enter" : "send"}
					rows={3}
					className="field-sizing-content lh-input max-h-64 min-h-14 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground"
				/>
				<div className="flex items-center justify-between gap-2 p-1">
					<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
						{compactionRunning ? "compacting session…" : coarse ? "" : "↵ submits · ⇧↵ newline"}
					</span>
					<div className="ml-auto flex items-center gap-1.5">
						{onHint && (
							<Button type="button" variant="outline" data-testid="work-hint" disabled={compactionRunning} onClick={onHint} className="h-9 gap-1.5 rounded-[6px] px-3 text-sm">
								<LightbulbIcon className="size-4" /> Hint
							</Button>
						)}
						<Button type="button" data-testid="work-send" disabled={!canSubmit} onClick={submit} className="h-9 rounded-[6px] px-3.5 text-sm font-medium">
							Submit
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
