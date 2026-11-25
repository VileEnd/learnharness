/**
 * MESSAGE ATTACHMENTS: images and free drawings on messages and thinking (core/attachments.ts). The limits the
 * server enforces (input parsing, existence), the store, and the model context: the current turn's attachments are
 * images plus the reader's description on a vision model, older ones are their cached description, and every
 * failure degrades to the "description unavailable" note.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	ATTACHMENT_UNAVAILABLE_NOTE,
	MAX_ATTACHMENTS,
	attachmentsOf,
	checkImageDimensions,
	parseAttachmentRefs,
	sniffImageType,
	type AttachmentRef,
} from "../src/core/attachments.ts";
import { ChatInputError, inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { newThinkingMessage, newUserMessage, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import type { AttachmentStore, DrawingStore } from "../src/core/ports.ts";
import { drawingIdOf, type DrawingScene } from "../src/core/canvas-core.ts";
import { attachmentStore } from "../src/store/attachments.ts";
import { createDrawingTranscriber, DESCRIBE_IMAGE_PROMPT } from "../src/agent/subagents/drawing-transcriber.ts";
import { currentAttachments, prepareAttachmentContext } from "../src/server/attachment-context.ts";
import { drawingIdsOfRecord } from "../src/agent/tools/annotate.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { call, chat, prose, result } from "./learner-helpers.ts";

const JPEG = (() => {
	const canvas = createCanvas(3, 2);
	canvas.getContext("2d").fillRect(0, 0, 3, 2);
	return new Uint8Array(canvas.toBuffer("image/jpeg"));
})();
const PNG = (() => {
	const canvas = createCanvas(1, 1);
	canvas.getContext("2d").fillRect(0, 0, 1, 1);
	return new Uint8Array(canvas.toBuffer("image/png"));
})();
const img = (n: number): AttachmentRef => ({ kind: "image", id: `img_${String(n).padStart(16, "0")}` });
const SCENE = { version: 1, objects: [{ id: "o1", type: "text", x: 10, y: 10, w: 100, h: 30, source: "x = 2" }] } as unknown as DrawingScene;
const DRAWING: AttachmentRef = { kind: "drawing", id: drawingIdOf(SCENE) };

describe("attachment references and bytes", () => {
	it("a list holds at most four well-formed, distinct references", () => {
		assert.deepEqual(parseAttachmentRefs([img(1), { ...DRAWING, extra: 1 }]), [img(1), DRAWING]);
		assert.throws(() => parseAttachmentRefs([img(1), img(2), img(3), img(4), img(5)]), /at most 4/);
		assert.throws(() => parseAttachmentRefs([{ kind: "image", id: "../etc/passwd" }]), /invalid/);
		assert.throws(() => parseAttachmentRefs([{ kind: "video", id: img(1).id }]), /invalid/);
		assert.throws(() => parseAttachmentRefs([img(1), img(1)]), /twice/);
		assert.equal(MAX_ATTACHMENTS, 4);
	});

	it("the type comes from the bytes and the size from the header", () => {
		assert.equal(sniffImageType(JPEG), "image/jpeg");
		assert.equal(sniffImageType(PNG), "image/png");
		assert.equal(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
		assert.deepEqual(checkImageDimensions(JPEG, "image/jpeg"), { ok: true, width: 3, height: 2 });
		const huge = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x88, 0x13, 1, 0]); // GIF 5000x1
		assert.equal(checkImageDimensions(huge, "image/gif").ok, false);
	});

	it("each carrier reads its own field", () => {
		assert.deepEqual(attachmentsOf(newUserMessage("look", [img(1)])), [img(1)]);
		assert.deepEqual(attachmentsOf(newUserMessage("plain")), []);
		assert.deepEqual(attachmentsOf(newThinkingMessage("p1", "t", { attachments: [DRAWING] })), [DRAWING]);
		assert.deepEqual(attachmentsOf(result("q1", "quiz", { attachments: [img(1)], readingAttachments: [img(2)] })), [img(1), img(2)]);
	});
});

describe("input limits (the server never trusts the client)", () => {
	const exists = (known: AttachmentRef[]) => ({ attachmentExists: (_c: string, r: AttachmentRef) => known.some((k) => k.id === r.id) });

	it("a text message may be images only, but not empty", () => {
		assert.deepEqual(parseChatInput({ type: "text", text: "", attachments: [img(1)] }), { type: "text", text: "", attachments: [img(1)] });
		assert.throws(() => parseChatInput({ type: "text", text: "  " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "", attachments: [] }), ChatInputError);
	});

	it("more than four, a malformed id, or an attachment the chat does not hold is a 400", () => {
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachments: [1, 2, 3, 4, 5].map(img) }), /at most 4/);
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachments: [{ kind: "image", id: "a/b" }] }), ChatInputError);
		const input = parseChatInput({ type: "text", text: "x", attachments: [img(1)] });
		assert.throws(() => inputAppends({ id: "c", messages: [] }, input, exists([])), /unknown image/);
		const [msg] = inputAppends({ id: "c", messages: [] }, input, exists([img(1)]));
		assert.deepEqual(attachmentsOf(msg), [img(1)]);
	});

	it("an answer's attachments are checked and normalised like a message's", () => {
		const records: LhMessage[] = [call("q1", "quiz", { question: "?", options: [] })];
		const answer = (extra: Record<string, unknown>) =>
			parseChatInput({ type: "answer", toolCallId: "q1", answer: { kind: "quiz", questionText: "?", answers: [], dontKnow: true, answeredAt: new Date().toISOString(), ...extra } });
		assert.throws(() => inputAppends({ id: "c", messages: records }, answer({ attachments: [1, 2, 3, 4, 5].map(img) })), /at most 4/);
		assert.throws(() => inputAppends({ id: "c", messages: records }, answer({ readingAttachments: [img(9)] }), exists([])), /unknown image/);
		const [res] = inputAppends({ id: "c", messages: records }, answer({ attachments: [{ ...img(1), junk: true }] }), exists([img(1)]));
		assert.deepEqual((res as { details: { attachments: unknown } }).details.attachments, [img(1)]);
	});
});

describe("the attachment store", () => {
	it("is content-addressed, keeps the type, caches a transcript and is removed with the chat", () => {
		const { id } = attachmentStore.saveImage("chat_a", JPEG, "image/jpeg");
		assert.match(id, /^img_[0-9a-f]{16}$/);
		assert.equal(attachmentStore.saveImage("chat_a", JPEG, "image/jpeg").id, id, "same bytes, same id");
		assert.deepEqual(attachmentStore.getImage("chat_a", id), { bytes: JPEG, mimeType: "image/jpeg" });
		assert.equal(attachmentStore.getImage("chat_b", id), null, "another chat does not hold it");
		assert.equal(attachmentStore.getImage("chat_a", "../x"), null);
		attachmentStore.writeTranscript("chat_a", id, { model: "m", text: "a cat" });
		assert.deepEqual(attachmentStore.readTranscript("chat_a", id), { model: "m", text: "a cat" });
		attachmentStore.deleteForChat("chat_a");
		assert.equal(attachmentStore.getImage("chat_a", id), null);
	});
});

// ─── the model context ──────────────────────────────────────────────────────

const faux = createFauxCore({});
const withInput = (input: Array<"text" | "image">): PiEngine => ({ model: { ...faux.getModel(), input } as PiEngine["model"], streamFn: faux.streamSimple });
const multimodal = withInput(["text", "image"]);
const textOnly = withInput(["text"]);

/** Stub stores: images 1-4 and the drawing exist; transcripts live in maps. */
function stores() {
	const transcripts = new Map<string, { model: string; text: string }>();
	const attachmentStore = {
		getImage: (_c: string, id: string) => (/^img_0+[1-4]$/.test(id) ? { bytes: JPEG, mimeType: "image/jpeg" } : null),
		readTranscript: (_c: string, id: string) => transcripts.get(id) ?? null,
		writeTranscript: (_c: string, id: string, t: { model: string; text: string }) => void transcripts.set(id, t),
	} as unknown as AttachmentStore;
	const drawingStore = {
		getScene: (_c: string, id: string) => (id === DRAWING.id ? SCENE : null),
		getPng: (_c: string, id: string) => (id === DRAWING.id ? PNG : null),
		readTranscript: (_c: string, id: string) => transcripts.get(id) ?? null,
		writeTranscript: (_c: string, id: string, t: { model: string; text: string }) => void transcripts.set(id, t),
	} as unknown as DrawingStore;
	return { attachmentStore, drawingStore, transcripts };
}

/** A reader that answers `text` once per call and records the system prompts it was given. */
function reader(text: string) {
	const prompts: string[] = [];
	const f = createFauxCore({});
	f.setResponses(Array.from({ length: 8 }, () => (ctx: { messages: unknown[] }) => {
		prompts.push(JSON.stringify(ctx.messages));
		return fauxAssistantMessage(text);
	}));
	return { transcriber: createDrawingTranscriber({ engineFor: () => ({ model: f.getModel(), streamFn: f.streamSimple }) }), prompts };
}

const older = newUserMessage("first look", [img(1)]);
const reply = prose("Nice picture.");
const current = newUserMessage("and now this", [img(2), DRAWING]);
const RECORD = [older, reply, current];

type Block = { type: string; text?: string };
const blocksOf = (out: ReturnType<typeof toLlmMessages>): Block[] =>
	out.flatMap((m) => (Array.isArray(m.content) ? (m.content as Block[]) : [{ type: "text", text: m.content as string }]));
const textOf = (out: ReturnType<typeof toLlmMessages>) => blocksOf(out).filter((b) => b.type === "text").map((b) => b.text).join("\n---\n");
const imageCount = (out: ReturnType<typeof toLlmMessages>) => blocksOf(out).filter((b) => b.type === "image").length;

describe("attachments in the model context", () => {
	it("the current turn is the input after the last completed reply", () => {
		assert.deepEqual(currentAttachments(RECORD), [img(2), DRAWING]);
		assert.deepEqual(currentAttachments([older]), [img(1)]);
	});

	it("a vision model sees the current turn's images with their descriptions; an older one is its cached description", async () => {
		const s = stores();
		s.transcripts.set(img(1).id, { model: "m", text: "a red square" });
		const { transcriber, prompts } = reader("<described>");
		const ctx = await prepareAttachmentContext(chat("c", RECORD), multimodal, { ...s, transcriber });
		const out = toLlmMessages(RECORD as never, { attachments: ctx });
		assert.equal(imageCount(out), 2, "the current image and the current drawing");
		const text = textOf(out);
		assert.match(text, /\[image: a red square\]/, "the older image is its cached description");
		assert.match(text, /\[Attachment 1: image\]\nDescription[^\n]*\n<described>/);
		assert.match(text, /\[Attachment 2: drawing drw_[0-9a-f]{12}\]\nThe attached image shows the learner's drawing/);
		assert.match(text, /x = 2/, "the drawing's structured text rides along");
		assert.equal(prompts.length, 2, "only the current turn's attachments are read");
		assert.equal(prompts.filter((p) => p.includes(JSON.stringify(DESCRIBE_IMAGE_PROMPT).slice(1, 60))).length, 1, "an image is read with the image rules, the drawing with the grid rules");
		assert.equal(s.transcripts.get(img(2).id)?.text, "<described>", "the description is cached");
		assert.equal(out.some((m) => "attachments" in m), false, "the record field never reaches the wire");
	});

	it("a text-only model always gets descriptions, never an image", async () => {
		const s = stores();
		const ctx = await prepareAttachmentContext(chat("c", RECORD), textOnly, { ...s, transcriber: reader("<d>").transcriber });
		const out = toLlmMessages(RECORD as never, { attachments: ctx });
		assert.equal(imageCount(out), 0);
		assert.match(textOf(out), /\[image: <d>\]/);
		assert.match(textOf(out), new RegExp(`\\[drawing ${DRAWING.id}: <d>\\]`));
		assert.ok(textOf(out).includes(ATTACHMENT_UNAVAILABLE_NOTE), "the older image, never read, is the unavailable note");
	});

	it("no vision reader, a failed or a hung reader: the unavailable note, never a failed turn", async () => {
		const unavailable = new RegExp(ATTACHMENT_UNAVAILABLE_NOTE.replace(/[[\]]/g, "\\$&"));
		const none = await prepareAttachmentContext(chat("c", [current]), textOnly, stores());
		assert.match(textOf(toLlmMessages([current] as never, { attachments: none })), unavailable);
		const failing = { describeImage: async () => { throw new Error("boom"); }, transcribe: async () => { throw new Error("boom"); } };
		const failed = await prepareAttachmentContext(chat("c", [current]), multimodal, { ...stores(), transcriber: failing });
		const out = toLlmMessages([current] as never, { attachments: failed });
		assert.equal(imageCount(out), 2, "a vision model keeps the images");
		let signal: AbortSignal | undefined;
		const hung = { describeImage: (_b: Uint8Array, _m: string, o?: { signal?: AbortSignal }) => { signal = o?.signal; return new Promise<never>(() => {}); }, transcribe: () => new Promise<never>(() => {}) };
		const started = Date.now();
		const slow = await prepareAttachmentContext(chat("c", [current]), textOnly, { ...stores(), transcriber: hung, readerTimeoutMs: 20 });
		assert.ok(Date.now() - started < 1000, "the readings share one time bound");
		assert.equal(signal?.aborted, true);
		assert.match(textOf(toLlmMessages([current] as never, { attachments: slow })), unavailable);
		// No context at all (compaction's estimate, any other caller): the note, and no empty text block.
		const bare = toLlmMessages([newUserMessage("", [img(1)])] as never);
		assert.equal(textOf(bare), ATTACHMENT_UNAVAILABLE_NOTE);
	});

	it("an answer's thinking attachments ride in its tool result", async () => {
		const answer = result("q1", "quiz", { kind: "quiz", attachments: [img(3)] });
		const record = [call("q1", "quiz", { question: "?" }), answer];
		const ctx = await prepareAttachmentContext(chat("c", record), multimodal, { ...stores(), transcriber: reader("<d>").transcriber });
		const res = toLlmMessages(record as never, { attachments: ctx }).find((m) => m.role === "toolResult")!;
		assert.deepEqual(res.content.map((b) => b.type), ["text", "text", "image"]);
	});

	it("annotate is armed by a drawing attached to a message", () => {
		assert.deepEqual(drawingIdsOfRecord([current]), [DRAWING.id]);
	});
});
