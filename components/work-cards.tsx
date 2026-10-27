"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { ThinkingBlock } from "@/components/thinking-block";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The canvas-task transcript cards (PR 2):
 * - WorkCard: the pose (work / sketch). The question only; the committed correctAnswer rides the call's
 *   arguments and never renders until `grade` closes the task (the grade chip reveals it).
 * - WorkSubmissionCard: the learner's submission (the `data-work-submission` part): a thumbnail of the
 *   exported drawing (when one rode along) above the "Your thinking" text.
 */

export function drawingPngUrl(chatId: string, drawingId: string): string {
	return `/api/chats/${encodeURIComponent(chatId)}/drawings/${encodeURIComponent(drawingId)}?format=png`;
}

export function WorkCard({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as { question?: unknown; details?: unknown };
	const question = typeof input.question === "string" ? input.question : "";
	const details = typeof input.details === "string" ? input.details : "";
	if (!question) return null;
	return (
		<div data-testid="work-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Canvas task</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{question}</ToolContentResponse>
				{details ? <ToolContentResponse>{details}</ToolContentResponse> : null}
			</div>
		</div>
	);
}

/** The work-submission marker's details (native-messages.ts newWorkSubmission). */
export interface WorkSubmissionData {
	workCallId: string;
	text: string;
	drawingId?: string;
}

/** A drawing thumbnail (the exported PNG), linking to the full image. Renders nothing for an absent id. */
export function DrawingThumb({ chatId, drawingId }: { chatId: string; drawingId?: string }) {
	if (!drawingId) return null;
	const src = drawingPngUrl(chatId, drawingId);
	return (
		<a href={src} target="_blank" rel="noreferrer" data-testid="drawing-thumb" className="mb-1 block w-fit">
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={src} alt="Your drawing" loading="lazy" className="max-h-40 max-w-full rounded-md border bg-white" />
		</a>
	);
}

export function WorkSubmissionCard({ data, chatId }: { data: WorkSubmissionData; chatId: string }) {
	return (
		<div data-testid="work-submission-card">
			<DrawingThumb chatId={chatId} drawingId={data.drawingId} />
			{data.text.trim().length > 0 && <ThinkingBlock testId="thinking-card" label="YOUR THINKING" text={data.text} defaultOpen />}
		</div>
	);
}

export function WorkDismissedLine() {
	return (
		<div data-testid="work-dismissed-line" className="my-1 px-1 text-sm text-muted-foreground/70">
			Canvas task dismissed.
		</div>
	);
}
