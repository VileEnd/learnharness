/**
 * The drawing transcriber (PR 2, Task 10): a vision-slot, single-call
 * sub-agent that turns a learner's drawing (PNG + its structured text) into
 * text. It always runs (2026-10-28): a text-only tutor reads the transcript
 * instead of the image, a vision tutor gets both. Rules ported from the OCR
 * sidecar's SCAN_PROMPT (services/ocr/app/pipeline.py): LaTeX for math,
 * Mermaid for diagrams, ~~struck~~ for crossed-out work.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EngineOptions, PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";

export const TRANSCRIBE_PROMPT = `You are transcribing a learner's hand-drawn canvas (an image) into text for a tutor (who may or may not also see the image).
The image has a labelled grid: columns A-H left to right, rows numbered from 1 at the top. Typed objects carry ids (o1, o2, ...) that match the structured text you are given. Freehand strokes appear there as [s4 blue stroke, vertical line @D1-D5] with a code-computed shape hint; trust the hint and the cell span over your reading of the picture.
Transcribe EVERYTHING drawn, faithfully, in the drawing's own language:
- Handwriting and text as plain text; math as LaTeX ($...$ inline, $$...$$ display); tables as markdown tables.
- Hand-drawn diagrams (flowcharts, graphs, trees, circuits, block diagrams): a \`\`\`mermaid block, quoting every node label (A["label"]) and edge label (A -- "label" --> B), whenever the structure can be reproduced faithfully; otherwise describe it as *[Diagram: ...]*, naming every label and arrow.
- Plots, axes and curves: a short description of axes, labels, intercepts and the shape drawn.
- Crossed-out content: keep it, wrapped in ~~strikethrough~~, so it is clear it was struck out.
- Tag EVERY region with its grid location, in square brackets before it: [C4] for one cell, [B2-D3] for a span.
Do not invent content, do not correct the learner's mistakes, and mark unreadable parts as [unreadable]. Output only the transcription.`;

export interface DrawingTranscriberDeps {
	/** The reader's engine. It is asked for at the LOWEST thinking level its
	 *  model supports: a transcription needs no reasoning, and a reasoning
	 *  reader ran into the 45 s turn bound on every hint (2026-10-29). */
	engineFor(role: "transcriber", opts: EngineOptions): PiEngine | undefined;
}

export interface TranscribeOptions {
	/** The money channel, one call per model request, stamped with the
	 *  reader's own provider-qualified model (priced at its rates). */
	onUsage?: (usage: Usage, model: string) => void;
	/** Cancels the request (the caller's time bound). */
	signal?: AbortSignal;
	/** Debug: LH_PROVIDER_EVENTS=1 records the raw provider events under
	 *  this chat, context "job:transcriber". */
	chatId?: string;
}

export interface DrawingTranscriber {
	transcribe(png: Uint8Array, structured: string, opts?: TranscribeOptions): Promise<{ model: string; text: string }>;
}

export function createDrawingTranscriber(deps: DrawingTranscriberDeps): DrawingTranscriber {
	return {
		async transcribe(png, structured, opts = {}) {
			const engine = deps.engineFor("transcriber", { thinking: "lowest" });
			if (!engine) throw new Error("no transcriber model configured");
			const model = `${engine.model.provider}:${engine.model.id}`;
			const { onUsage } = opts;
			const message: AgentMessage = {
				role: "user",
				content: [
					{ type: "text", text: structured ? `Structured text (typed objects, then a code-computed stroke digest, one line per freehand stroke):\n${structured}` : "No typed objects or strokes." },
					{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
				],
				timestamp: Date.now(),
			};
			const { text } = await runSubagent([], {
				role: "transcriber",
				engine,
				systemPrompt: TRANSCRIBE_PROMPT,
				messages: [message],
				maxTurns: 1,
				...(onUsage ? { onUsage: (usage: Usage) => onUsage(usage, model) } : {}),
				...(opts.signal ? { abortSignal: opts.signal } : {}),
				...(opts.chatId ? { chatId: opts.chatId } : {}),
			});
			const out = text.trim();
			if (!out) throw new Error("the transcriber returned nothing");
			return { model, text: out };
		},
	};
}
