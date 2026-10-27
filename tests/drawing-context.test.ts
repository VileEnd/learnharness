/**
 * DRAWINGS IN THE MODEL CONTEXT (PR 2, Task 10): the newest active drawing
 * is an image (or a cached vision transcript for a text-only model); earlier
 * and closed ones collapse to text stubs; a failed transcription never fails
 * the turn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { DrawingStore } from "../src/core/ports.ts";
import { drawingIdOf, type DrawingScene } from "../src/core/canvas-core.ts";
import { ESTIMATED_IMAGE_CHARS, estimateMessageTokens } from "../src/core/compaction.ts";
import { newThinkingMessage, newWorkSubmission, toLlmMessages, type DrawingContext, type LhMessage } from "../src/core/native-messages.ts";
import { createDrawingTranscriber } from "../src/agent/subagents/drawing-transcriber.ts";
import { prepareDrawingContext } from "../src/server/drawing-context.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { call, chat, result } from "./learner-helpers.ts";

const WORK_ARGS = { type: "check", nodeId: "n", question: "Sketch y = x^2", correctAnswer: "A parabola." };
const sceneOf = (n: number): DrawingScene =>
	({ version: 1, objects: [{ id: `o${n}`, type: "text", x: 10, y: 10, w: 100, h: 30, source: `note ${n}` }] }) as unknown as DrawingScene;
const SCENES = [sceneOf(1), sceneOf(2)];
const IDS = SCENES.map(drawingIdOf);

/** A stubbed store: both drawings have a png; transcripts live in a map. */
function store() {
	const transcripts = new Map<string, { model: string; text: string }>();
	const s = {
		getScene: (_c: string, id: string) => SCENES[IDS.indexOf(id)] ?? null,
		getPng: (_c: string, id: string) => (IDS.includes(id) ? new Uint8Array([1, 2, 3]) : null),
		readTranscript: (_c: string, id: string) => transcripts.get(id) ?? null,
		writeTranscript: (_c: string, id: string, t: { model: string; text: string }) => void transcripts.set(id, t),
	} as unknown as DrawingStore;
	return { s, transcripts };
}

const faux = createFauxCore({});
const withInput = (input: Array<"text" | "image">): PiEngine => ({ model: { ...faux.getModel(), input } as PiEngine["model"], streamFn: faux.streamSimple });
const multimodal = withInput(["text", "image"]);
const textOnly = withInput(["text"]);

const pose = (): LhMessage[] => [call("w1", "work", WORK_ARGS), result("w1", "work", null)];
const sub = (i: number) => newWorkSubmission("w1", `try ${i}`, IDS[i]);
const close = (): LhMessage[] => [call("g1", "grade", { question: "w1", grade: "correct", note: "n" }), result("g1", "grade", "Recorded: correct.")];

const userBlocks = (out: ReturnType<typeof toLlmMessages>) =>
	out.filter((m) => m.role === "user").flatMap((m) => (Array.isArray(m.content) ? m.content : []));
const textOf = (out: ReturnType<typeof toLlmMessages>) => userBlocks(out).filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n---\n");
const images = (out: ReturnType<typeof toLlmMessages>) => userBlocks(out).filter((b) => b.type === "image");

describe("drawings in the model context", () => {
	it("active drawing sent as image to multimodal model", async () => {
		const messages = [...pose(), sub(0)];
		const ctx = await prepareDrawingContext(chat("c", messages), multimodal, { drawingStore: store().s });
		const out = toLlmMessages(messages as never, { drawing: ctx });
		const last = out[out.length - 1]!;
		assert.equal(last.role, "user");
		assert.ok((last.content as Array<{ type: string }>).some((b) => b.type === "image"));
		assert.match(textOf(out), /columns A-H/);
		assert.match(textOf(out), /note 1/);
	});

	it("closed task collapses to stub", async () => {
		const messages = [...pose(), sub(0), ...close()];
		const ctx = await prepareDrawingContext(chat("c", messages), multimodal, { drawingStore: store().s });
		const out = toLlmMessages(messages as never, { drawing: ctx });
		assert.equal(images(out).length, 0);
		assert.match(textOf(out), /omitted — task closed/);
	});

	it("only the newest drawing is an image", async () => {
		const messages = [...pose(), sub(0), sub(1)];
		const ctx = await prepareDrawingContext(chat("c", messages), multimodal, { drawingStore: store().s });
		const out = toLlmMessages(messages as never, { drawing: ctx });
		assert.equal(images(out).length, 1);
		assert.match(textOf(out), new RegExp(`\\[earlier drawing ${IDS[0]} — superseded\\]`));
	});

	it("a practice thinking marker with a drawing is handled like a work submission", async () => {
		const messages = [call("p1", "problem", { statement: "s" }), result("p1", "problem", null), newThinkingMessage("p1", "idea", { drawingId: IDS[0] })];
		const ctx = await prepareDrawingContext(chat("c", messages), multimodal, { drawingStore: store().s });
		assert.equal(images(toLlmMessages(messages as never, { drawing: ctx })).length, 1);
	});

	it("text-only model gets cached transcript", async () => {
		const messages = [...pose(), sub(0)];
		const { s } = store();
		let calls = 0;
		const f = createFauxCore({});
		f.setResponses([() => { calls++; return fauxAssistantMessage("[C4] y = $x^2$"); }]);
		const transcriber = createDrawingTranscriber({ engineFor: () => ({ model: f.getModel(), streamFn: f.streamSimple }) });
		for (let turn = 0; turn < 2; turn++) {
			const ctx = await prepareDrawingContext(chat("c", messages), textOnly, { drawingStore: s, transcriber });
			const out = toLlmMessages(messages as never, { drawing: ctx });
			assert.equal(images(out).length, 0);
			assert.match(textOf(out), /Transcription:\n\[C4\] y = \$x\^2\$/);
		}
		assert.equal(calls, 1);
	});

	it("transcription usage is reported once (cache hit reports none)", async () => {
		const messages = [...pose(), sub(0)];
		const { s } = store();
		const f = createFauxCore({});
		f.setResponses([fauxAssistantMessage("[C4] y")]);
		const transcriber = createDrawingTranscriber({ engineFor: () => ({ model: f.getModel(), streamFn: f.streamSimple }) });
		let usages = 0;
		const onUsage = () => { usages++; };
		await prepareDrawingContext(chat("c", messages), textOnly, { drawingStore: s, transcriber, onUsage });
		await prepareDrawingContext(chat("c", messages), textOnly, { drawingStore: s, transcriber, onUsage });
		assert.equal(usages, 1);
	});

	it("text-only without transcriber falls back to stub", async () => {
		const messages = [...pose(), sub(0)];
		const transcriber = createDrawingTranscriber({ engineFor: () => undefined });
		const ctx = await prepareDrawingContext(chat("c", messages), textOnly, { drawingStore: store().s, transcriber });
		const out = toLlmMessages(messages as never, { drawing: ctx });
		assert.match(textOf(out), /transcription unavailable/);
		assert.match(textOf(out), /note 1/);
	});

	it("transcriber failure is contained", async () => {
		const messages = [...pose(), sub(0)];
		const f = createFauxCore({});
		f.setResponses([() => { throw new Error("boom"); }]);
		const transcriber = createDrawingTranscriber({ engineFor: () => ({ model: f.getModel(), streamFn: f.streamSimple }) });
		const { s, transcripts } = store();
		const ctx: DrawingContext = await prepareDrawingContext(chat("c", messages), textOnly, { drawingStore: s, transcriber });
		assert.equal(transcripts.size, 0, "nothing cached");
		assert.match(textOf(toLlmMessages(messages as never, { drawing: ctx })), /transcription unavailable/);
	});

	it("without a drawing context the marker renders as before", () => {
		const out = toLlmMessages([...pose(), sub(0)] as never);
		assert.equal(images(out).length, 0);
		assert.match(textOf(out), /\[drawing drw_/);
	});

	it("compaction estimate counts the image", async () => {
		// The drawing as the model receives it: the estimator must charge the
		// image block its allowance (~2 800 tokens), not zero.
		const messages = [...pose(), sub(0)];
		const ctx = await prepareDrawingContext(chat("c", messages), multimodal, { drawingStore: store().s });
		const last = toLlmMessages(messages as never, { drawing: ctx }).at(-1)!;
		const blocks = last.content as Array<{ type: string; text?: string }>;
		assert.equal(blocks.filter((b) => b.type === "image").length, 1);
		const textChars = blocks.reduce((n, b) => n + (b.type === "text" ? (b.text?.length ?? 0) : 0), 0);
		assert.equal(estimateMessageTokens(last as never), Math.ceil((textChars + ESTIMATED_IMAGE_CHARS) / 4));
		assert.ok(estimateMessageTokens(last as never) - Math.ceil(textChars / 4) >= 2_800);
	});
});
