"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { ThinkingBlock } from "@/components/thinking-block";
import { createContext, useContext, useMemo } from "react";
import { TeacherInk, teacherInkView } from "@/components/canvas/teacher-ink";
import { useDrawingScene } from "@/components/canvas/use-drawing-scene";
import { annotationsOf, sceneBoundingBox, type ArtifactPartProps } from "@/src/core";

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

/** The session's record messages, for the derived teacher marks (annotationsOf). chat.tsx provides it. */
export const SessionMessagesContext = createContext<readonly unknown[]>([]);

/** The thumbnail's height cap in px (max-h-40). */
const THUMB_MAX_H = 160;

/**
 * A drawing thumbnail (the exported PNG), linking to the full image, with the teacher's marks over it
 * (percent space). Renders nothing for an absent id. Once the scene is known, the thumbnail is a sheet of
 * paper the size of teacherInkView's view: the drawing keeps its place and aspect inside it, and blank paper
 * is added wherever a note or mark reaches past the drawing, so nothing is clipped. The whole sheet stays
 * within the old cap (160px tall, the column's width), scaled down when it grew.
 */
export function DrawingThumb({ chatId, drawingId }: { chatId: string; drawingId?: string }) {
	const messages = useContext(SessionMessagesContext);
	const marks = useMemo(() => (drawingId ? annotationsOf(messages, drawingId).flatMap((a) => a.marks) : []), [messages, drawingId]);
	const scene = useDrawingScene(chatId, marks.length > 0 ? drawingId : undefined);
	const box = useMemo(() => (scene ? sceneBoundingBox(scene) : null), [scene]);
	const paper = useMemo(() => (scene && box ? teacherInkView(marks, scene, box) : null), [marks, scene, box]);
	if (!drawingId) return null;
	const src = drawingPngUrl(chatId, drawingId);
	if (!scene || !box || !paper) {
		return (
			<div className="relative mb-1 w-fit max-w-full" data-testid="drawing-thumb-wrap">
				<a href={src} target="_blank" rel="noreferrer" data-testid="drawing-thumb" className="block w-fit">
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={src} alt="Your drawing" loading="lazy" className="max-h-40 max-w-full rounded-md border bg-white" />
				</a>
			</div>
		);
	}
	const { drawing: d, view: v } = paper;
	const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
	return (
		<div className="relative mb-1 max-w-full" style={{ width: `min(100%, ${((THUMB_MAX_H * v.w) / v.h).toFixed(1)}px)`, aspectRatio: `${v.w} / ${v.h}` }} data-testid="drawing-thumb-wrap">
			<a href={src} target="_blank" rel="noreferrer" data-testid="drawing-thumb" className="absolute inset-0 block overflow-hidden rounded-md border bg-white">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src={src}
					alt="Your drawing"
					loading="lazy"
					className="absolute max-w-none"
					style={{ left: pct((d.x - v.x) / v.w), top: pct((d.y - v.y) / v.h), width: pct(d.w / v.w), height: pct(d.h / v.h) }}
				/>
			</a>
			<TeacherInk marks={marks} scene={scene} box={box} space="percent" theme="light" />
		</div>
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
