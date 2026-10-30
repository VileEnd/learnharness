"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronRightIcon, PenLineIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { enterSends, useEnterSubmits } from "@/components/enter-submits";
import { useAutoGrow, useCoarsePointer } from "@/components/use-coarse-pointer";
import { cn } from "@/lib/utils";
import { ExerciseWidget } from "@/components/exercise/exercise-widget";
import { UnreadableNotice } from "@/components/exercise/widget-shared";
import { emptyResponse, hasAnyText } from "@/components/exercise/attempt-state";
import { gradeExercise, parseExerciseInput, stripExpected, unreadableItems, type ExerciseVerdict, type ThinkingAttempt } from "@/src/core";

/** The thinking sent with a Check that carries no words of its own. */
const CHECK_TEXT = "Here is my attempt.";

/**
 * The practice dock (practice sessions, owner design 2026-10-04): an
 * ACTIVE problem replaces the chat composer — the persistent bottom blob
 * morphs into the problem. The agent's statement above; the learner's
 * half below — "Your thinking", a labeled field with ONE Send button
 * (owner round 2, 2026-10-05): Enter sends, Shift+Enter makes a newline.
 * There are no lanes — whether a submission claims an answer is apparent
 * from the thinking itself; the agent reads it. One problem may carry
 * many submissions; each starts a turn.
 *
 * Collapse (scroll-up → slim bar) is owned by the DockOverlay; this
 * component is content only, and the expanded form stays MOUNTED while
 * collapsed (hidden) so a half-written trace survives scrolling.
 *
 * The commitment (modelSolution, decisionPoints, …) rides the tool call's
 * arguments and is NOT rendered here — only the statement is the
 * learner's. Esc dismisses the problem (the layered-Esc chain; the
 * confirm dialog then the silent route) — claimed by the page, not here.
 */

export interface PracticeDockProps {
	/** The active problem's tool-call id (submissions target it). */
	problemCallId: string;
	/** The pose's arguments — only the statement is the learner's (the
	 *  mode badge would edge toward announcing the target; dropped). */
	input: { statement: string; format?: unknown; spec?: unknown; canvas?: boolean };
	/** Collapse state, owned by the DockOverlay. */
	expanded: boolean;
	onExpand: () => void;
	/** text — POST {type:"thinking"} (one lane; the register is read from the text). */
	onSubmit: (text: string, attempt?: ThinkingAttempt) => void;
	/** Escape in the thinking field stops dictation (threaded from the page). */
	onEscape?: () => void;
	/** Compaction is running for this chat (owner round 14): the thinking
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
	/** The Hint button: the host sends { type: "hint", callId } and the agent answers with the next rung only. */
	onHint?: () => void;
	/** A canvas problem (`input.canvas`): the device can draw / opens the workspace. */
	canvasCapable?: boolean;
	onOpenCanvas?: () => void;
	/** False while the canvas workspace is open: its field then owns the
	 *  dictation claim and the window-level Enter. Default true. */
	active?: boolean;
	/** Exercise problems: the attempt to start from (marks only; the seam
	 *  the render tests drive). Fresh problems start empty. */
	initialAttempt?: { response: unknown; verdict?: ExerciseVerdict };
}

export function PracticeDock({ problemCallId, input, expanded, onExpand, onSubmit, onHint, canvasCapable = false, onOpenCanvas, active = true, onEscape, compactionRunning = false, initialAttempt }: PracticeDockProps) {
	const [thinking, setThinking] = useState("");
	// An interactive problem (`format` + `spec` on the pose): the widget sits
	// under the statement; Check grades locally, shows ✓/✗ without the key and
	// sends the attempt with the thinking. The key shows only after conclude.
	const parsedEx = input.format !== undefined ? parseExerciseInput({ question: input.statement, explanation: "", hints: [], ...input }) : undefined;
	const ex = parsedEx?.ok ? parsedEx.input : undefined;
	const [response, setResponse] = useState<unknown>(() => initialAttempt?.response ?? (ex ? emptyResponse(ex.format, ex.spec) : null));
	const [verdict, setVerdict] = useState<ExerciseVerdict | undefined>(initialAttempt?.verdict);
	// Ref MIRRORS the field ("nothing gets lost", the question-dock
	// discipline): a submit resuming after `await finishDictation()` reads
	// the tail, never a stale closure.
	const thinkingRef = useRef("");

	useDictationTarget(
		useCallback(
			(t: string) => {
				const v = joinDictation(thinkingRef.current, t);
				thinkingRef.current = v;
				setThinking(v);
			},
			[],
		),
		active,
	);

	const coarse = useCoarsePointer();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(fieldRef, thinking);

	const submit = () => {
		if (compactionRunning || !active) return;
		const text = thinkingRef.current.trim();
		if (text.length === 0) return;
		thinkingRef.current = "";
		setThinking("");
		onSubmit(text);
	};

	const canCheck = !!ex && !compactionRunning && hasAnyText(response);
	// Unreadable entries refuse the Check: nothing is sent, nothing counts.
	const [unreadableCount, setUnreadableCount] = useState(0);
	const check = () => {
		if (!ex || !canCheck) return;
		const unread = unreadableItems(ex.format, ex.spec, response);
		setUnreadableCount(unread.length);
		if (unread.length > 0) return;
		const full = gradeExercise(ex.format, ex.spec, response);
		const marks = stripExpected(full);
		setVerdict(marks);
		const text = thinkingRef.current.trim() || CHECK_TEXT;
		thinkingRef.current = "";
		setThinking("");
		onSubmit(text, { format: ex.format, response, verdict: marks });
	};
	const askForHint = () => {
		if (compactionRunning) return;
		onHint?.();
	};

	/* ENTER SUBMITS FROM ANYWHERE (owner round 6, 2026-10-05): dictation
	 * means the field is often never focused — the window-level Enter
	 * (typing surfaces and buttons excluded) submits the trace. Mounted
	 * while the dock is — collapsed bar included (the trace survives). */
	useEnterSubmits(submit);

	/* ── the collapsed bar ── */
	if (!expanded) {
		return (
			<button
				type="button"
				data-testid="practice-dock-bar"
				onClick={onExpand}
				className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon className="size-4 shrink-0 rotate-90" />
				<span className="font-medium">Problem</span>
				<span className="min-w-0 flex-1 truncate">{input.statement}</span>
			</button>
		);
	}

	/* ── the expanded form ── */
	return (
		<div data-testid="practice-dock" data-problem={problemCallId}>
			{/* The agent's half: the 'Problem' eyebrow (mirroring the quiz
			    cards' label row — owner round, 2026-10-05) + the statement,
			    markdown + LaTeX rendered, capped by the measured column
			    (--dock-max-h; the old fixed 40vh cut long problems short). */}
			<div data-dock-scroll-area="" className="max-h-[var(--dock-max-h,40vh)] overflow-y-auto px-4 pt-3 pb-2">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
				<div className="lh-prose text-[15px]">
					<ToolContentResponse>{input.statement}</ToolContentResponse>
				</div>
				{input.canvas === true && (
					<div className="mt-2">
						{canvasCapable ? (
							<Button type="button" variant="outline" data-testid="open-canvas" disabled={compactionRunning} onClick={onOpenCanvas} className="h-9 gap-1.5 rounded-[6px] px-3 text-sm">
								<PenLineIcon className="size-4" /> Open canvas
							</Button>
						) : (
							<span data-testid="canvas-phone-hint" className="text-xs text-muted-foreground">
								Draw on a tablet or computer
							</span>
						)}
					</div>
				)}
				{ex && (
					<div className="mt-2">
						<ExerciseWidget
							format={ex.format}
							spec={ex.spec}
							toolCallId={problemCallId}
							value={response}
							onChange={(next) => {
								setUnreadableCount(0);
								setResponse(next);
							}}
							review={verdict}
							marksOnly
						/>
						<UnreadableNotice count={unreadableCount} />
					</div>
				)}
			</div>

			{/* The learner's half: Enter SENDS (owner round 2, 2026-10-05);
			    Shift+Enter makes a newline — less to decide about. */}
			<div
				data-testid="practice-thinking-field"
				className="m-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
			>
				<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					YOUR THINKING
				</div>
				<textarea
					ref={fieldRef}
					value={thinking}
					onChange={(e) => {
						thinkingRef.current = e.target.value;
						setThinking(e.target.value);
					}}
					onKeyDown={(e) => {
						// Esc ends dictation — stopPropagation claims it (the
						// keyboard machine) so the window chain doesn't also fire.
						if (e.key === "Escape" && onEscape) {
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						// Enter SENDS — the single lane (owner round 2, 2026-10-05);
						// Shift+Enter is the newline, ⌘/Ctrl+Enter the chord too.
						if (enterSends(e, coarse)) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder="Work here, think out loud."
					enterKeyHint={coarse ? "enter" : "send"}
					rows={4}
					className={cn(
						"field-sizing-content lh-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground",
					)}
				/>
				{/* The submit row (owner round 4, 2026-10-05): IDENTICAL to the
				    question dock's — hint left, the SAME Button (h-9, px-3.5),
				    one p-1 row. Corner radii concentric: shell 16 − m-1.5 (6) =
				    field 10 − p-1 (4) = button 6. */}
				<div className="flex items-center justify-between gap-2 p-1">
					<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
						{compactionRunning ? "compacting session…" : coarse ? "" : "↵ submits · ⇧↵ newline"}
					</span>
					<div className="ml-auto flex items-center gap-1.5">
						{/* Hint: the agent answers with the next rung only. */}
						<Button
							type="button"
							variant="outline"
							data-testid="practice-hint"
							disabled={compactionRunning}
							onClick={askForHint}
							className="h-9 rounded-[6px] px-3 text-sm"
						>
							Hint
						</Button>
						{ex && (
							<Button
								type="button"
								variant="outline"
								data-testid="practice-check"
								disabled={!canCheck}
								onClick={check}
								className="h-9 rounded-[6px] px-3 text-sm"
							>
								Check
							</Button>
						)}
						<Button
							type="button"
							data-testid="practice-send"
							disabled={thinking.trim().length === 0 || compactionRunning}
							onClick={() => submit()}
							className="h-9 rounded-[6px] px-3.5 text-sm font-medium"
						>
							Submit thinking
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
