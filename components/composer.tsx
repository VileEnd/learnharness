"use client";

import { ArrowRightIcon, CornerDownLeftIcon, SquareIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";
import { enterSends } from "@/components/enter-submits";
import { useAutoGrow, useCoarsePointer } from "@/components/use-coarse-pointer";
import { AttachmentButtons, AttachmentStrip, useAttachmentDrop, type AttachmentDraft } from "@/components/attachments";

/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Corner-radius math (concentric with the shell): shell rounded-2xl (16px) −
 * row padding p-1.5 (6px) = button rounded-[10px] = 25% of the 40px button.
 */
/** What one Enter press does, in precedence order: stop a busy stream,
 *  otherwise send the message, otherwise — practice sessions only — fire
 *  the next-problem signal while the between-problems pause is live
 *  (owner round 16: Enter on an EMPTY composer is the go-ahead; typing
 *  anything makes Enter a send again). Pure so the static-render harness
 *  can pin the decision (key events can't be simulated in
 *  renderToStaticMarkup). */
export function enterAction(state: {
	busy: boolean;
	canSend: boolean;
	/** The between-problems pause is live: practice session, nothing
	 *  active, no turn/compaction in flight (the caller's fold). */
	nextProblem?: boolean;
	/** The send waits (composerHold). */
	hold?: boolean;
}): "stop" | "send" | "next" | "none" {
	// Composer steering (owner arc 2026-10-03): while a turn runs, typed
	// text makes Enter a STEER (the queue-and-redirect send); Enter with
	// an empty composer stays the stop shortcut. The button itself keeps
	// the square — Stop stays one click away at all times.
	// Attachments still uploading, or attachments while a turn runs (a steer
	// carries text only): Enter waits instead of stopping the turn.
	if (state.hold) return "none";
	if (state.busy) return state.canSend ? "send" : "stop";
	if (state.canSend) return "send";
	if (state.nextProblem) return "next";
	return "none";
}

/** Does a send wait for the attachments? While an image is still being prepared or uploaded, and while a turn runs
 *  with attachments in the strip and something to send: that send would be a steer, which carries text only, so
 *  the message waits (with its attachments) until the reply ends. With nothing typed the button stays Stop. Pure. */
export function composerHold(s: { busy: boolean; canSend: boolean; attachmentCount: number; attachmentsPending: boolean }): boolean {
	return s.attachmentsPending || (s.busy && s.canSend && s.attachmentCount > 0);
}

/** May the composer send? Allowed, and something to send: text, a live dictation, or (when no turn runs) a ready
 *  attachment. Pure. */
export function composerCanSend(s: { sendAllowed: boolean; busy: boolean; text: string; dictationActive: boolean; readyAttachments: number }): boolean {
	return s.sendAllowed && (s.text.trim().length > 0 || s.dictationActive || (!s.busy && s.readyAttachments > 0));
}

/**
 * Session composer with local keystroke state. The owning Chat keeps the
 * current draft in a ref for send/dictation, so typing doesn't re-render the
 * transcript; `revision` signals explicit parent-driven draft resets.
 */
export function ChatSessionComposer({
	value,
	revision,
	onChange,
	sendAllowed,
	dictationActive,
	...rest
}: Omit<React.ComponentProps<typeof Composer>, "canSend"> & {
	revision: number;
	sendAllowed: boolean;
	dictationActive: boolean;
}) {
	const [draft, setDraft] = useState(value);
	useLayoutEffect(() => { setDraft(value); }, [revision, value]);
	const canSend = composerCanSend({ sendAllowed, busy: rest.busy, text: draft, dictationActive, readyAttachments: rest.attachments?.refs.length ?? 0 });
	const applyDraft = useCallback((next: string) => {
		setDraft(next);
		onChange(next);
	}, [onChange]);
	return <Composer {...rest} value={draft} onChange={applyDraft} canSend={canSend} />;
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	autoFocus,
	inputRef,
	onEscape,
	placeholder = "Ask, answer, or steer the lesson…",
	nextProblem = false,
	onNext,
	attachments,
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	/** The page's handle to the textarea — the dictation-end focus (owner,
	 *  2026-10-01): a run ending hands the cursor to the bare composer. */
	inputRef?: React.RefObject<HTMLTextAreaElement | null>;
	/** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
	 *  when absent — Esc otherwise means nothing in the composer. */
	onEscape?: () => void;
	/** The textarea's placeholder (owner refinement round, 2026-09-24):
	 *  active sessions read "Ask, answer, or steer the lesson…"; the fresh
	 *  new-session page asks the graph view's opening question instead. */
	placeholder?: string;
	/** The practice pause is live (owner round 16): Enter on the empty
	 *  composer fires the next-problem signal instead of doing nothing —
	 *  the keyboard-first move-on. */
	nextProblem?: boolean;
	/** The signal's dispatcher (send({type:"next"})) — the chip and the
	 *  empty-Enter share it. */
	onNext?: () => void;
	/** Images and drawings for this message (components/attachments.tsx): the strip above the textarea, the attach
	 *  and Draw buttons, paste and drop. Absent = a text-only composer (the new-session page's opening prompt). */
	attachments?: AttachmentDraft;
}) {
	const coarse = useCoarsePointer();
	const ownRef = useRef<HTMLTextAreaElement>(null);
	const taRef = inputRef ?? ownRef;
	useAutoGrow(taRef, value);
	const hold = attachments ? composerHold({ busy, canSend, attachmentCount: attachments.items.length, attachmentsPending: attachments.pending }) : false;
	const { dragging, handlers: dropHandlers } = useAttachmentDrop(attachments);
	const act = () => {
		const action = enterAction({ busy, canSend, nextProblem, hold });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
		else if (action === "next") onNext?.();
	};
	return (
		<form
			data-testid="composer"
			className={cn("flex flex-col gap-1.5 rounded-2xl p-1.5", dragging && "bg-accent/60 ring-2 ring-primary/40")}
			onSubmit={(e) => {
				e.preventDefault();
				act();
			}}
			onDragOver={dropHandlers.onDragOver}
			onDragLeave={dropHandlers.onDragLeave}
			onDrop={dropHandlers.onDrop}
		>
			{attachments && (
				<AttachmentStrip
					draft={attachments}
					className="px-1 pt-0.5"
					note={busy && attachments.items.length > 0 ? "These send with your next message, once the reply ends." : undefined}
				/>
			)}
			<div className="flex min-w-0 items-end gap-1.5">
			{attachments && <AttachmentButtons draft={attachments} variant="icon" />}
			<textarea
				onPaste={dropHandlers.onPaste}
				ref={taRef}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					// Esc ends dictation before anything else Esc might someday mean
					// here (the dictate decisions: click-again or Esc to stop).
					// stopPropagation claims the Esc (keyboard wave A): the
					// window-level chain must not also abort a turn under us.
					if (e.key === "Escape" && onEscape) {
						e.preventDefault();
						e.stopPropagation();
						onEscape();
						return;
					}
					// Chat convention: Enter sends, Shift+Enter is a newline.
					// ⌘/Ctrl+Enter also sends — the universal submit shortcut
					// across every input in the app (thinking field, answers).
					// On touch, Return is a newline and only the button sends.
					if (enterSends(e, coarse)) {
						e.preventDefault();
						act();
					}
				}}
				placeholder={placeholder}
				enterKeyHint={coarse ? "enter" : "send"}
				autoFocus={autoFocus}
				rows={1}
				className="field-sizing-content lh-input max-h-48 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
			/>
			{/* The button follows the text (owner report 2026-10-03): while
				 a turn runs WITH text typed it stays the SEND affordance
				 (click = steer — steering must be clickable, not Enter-only);
				 only an empty composer morphs it to Stop. ESC keeps its
				 confirm-popup abort in every state, so stop is never
				 unreachable. No tooltip — the ↵ glyph is the affordance
				 (owner, subtlety round 2026-09-25).

				 THE NEXT MORPH (owner round 16 refinement, 2026-10-06): an
				 empty composer in the practice pause morphs the button into
				 a wide green NEXT PROBLEM — the affordance IS the button
				 (click and Enter share one lane), and typing anything
				 returns the regular send. The green is the app's correct-
				 answer register (answered-card's success tokens). */}
				{nextProblem && !busy && !canSend ? (
					<button
						type="submit"
						data-testid="next-problem-button"
						aria-label="Next problem"
						className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-success-strong px-4 font-ui text-xs font-medium uppercase tracking-wide text-white transition-colors hover:bg-success"
					>
						Next problem
						<ArrowRightIcon className="size-4" />
					</button>
				) : (
					<button
						type="submit"
						aria-label={busy && !canSend && !hold ? "Stop" : "Send"}
						disabled={hold || (!busy && !canSend)}
						className={cn(
							"flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
							busy && !canSend && !hold
								? "bg-secondary text-foreground hover:bg-accent"
								: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
						)}
					>
						{busy && !canSend && !hold ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
					</button>
				)}
			</div>
		</form>
	);
}
