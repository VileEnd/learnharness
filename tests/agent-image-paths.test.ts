/** Offline integration contracts at the provider boundary: real shared image
 * processing, faux model streams, synthetic rasters, and fake headless I/O.
 * No real browser, provider, learner data, or ambient credentials are used.
 * Ported from upstream 84f9399 (the pdf-reader cases are gone with the
 * pdf-reader); the library-rooted read and the canvas paths are fork-only. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import * as photon from "@silvia-odwyer/photon-node";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
	type ImageContent,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { ModelImageResizeOptions } from "../src/agent/image-processing/index.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import type { DrawingStore } from "../src/core/ports.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// Install storage/auth seams BEFORE importing the agent composition root.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agent-image-paths-"));
const library = path.join(scratch, "library");
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
fs.mkdirSync(path.join(scratch, "home"));
fs.mkdirSync(library);
fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	HOME: path.join(scratch, "home"),
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
};
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { readToolFor } = await import("../src/agent/tools/read.ts");
const { createTeacherAgent, createProberAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { runVisualMaker } = await import("../src/agent/subagents/visual-maker.ts");
const { prepareDrawingContext } = await import("../src/server/drawing-context.ts");
const { createDrawingTranscriber } = await import("../src/agent/subagents/drawing-transcriber.ts");
const { newWorkSubmission, toLlmMessages } = await import("../src/core/native-messages.ts");
const { drawingIdOf } = await import("../src/core/canvas-core.ts");
const { call, chat, result } = await import("./learner-helpers.ts");

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4800" height="120" viewBox="0 0 4800 120"><rect width="4800" height="120" fill="white"/></svg>';
const CUSTOM_RESIZE = { maxWidth: 320, maxHeight: 200 };

function png(width: number, height: number): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#336699";
	context.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

/** A JPEG carrying an EXIF orientation tag (APP1 right after SOI), the
 *  shape a phone camera writes. */
function exifJpeg(width: number, height: number, orientation: number): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#336699";
	context.fillRect(0, 0, width, height);
	const jpeg = canvas.toBuffer("image/jpeg", 80);
	const exif = Buffer.alloc(36);
	exif.set([0xff, 0xe1, 0, 34]);
	exif.write("Exif\0\0", 4, "binary");
	exif.write("II", 10);
	exif.writeUInt16LE(42, 12);
	exif.writeUInt32LE(8, 14);
	exif.writeUInt16LE(1, 18);
	exif.writeUInt16LE(0x0112, 20);
	exif.writeUInt16LE(3, 22);
	exif.writeUInt32LE(1, 24);
	exif.writeUInt16LE(orientation, 28);
	return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

function dimensions(image: { data: string }): { width: number; height: number } {
	const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, "base64"));
	try {
		return { width: decoded.get_width(), height: decoded.get_height() };
	} finally { decoded.free(); }
}

function images(context: TranscriptContext): ImageContent[] {
	return context.messages.flatMap((message) => Array.isArray(message.content)
		? message.content.filter((part): part is ImageContent => part.type === "image")
		: []);
}

function text(context: TranscriptContext): string {
	return context.messages.map((message) => typeof message.content === "string"
		? message.content
		: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
}

function scripted(steps: FauxResponseStep[], resize?: ModelImageResizeOptions, vision = true) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const base = faux.getModel();
	const model: PiEngine["model"] = {
		...base,
		input: vision ? ["text", "image"] : ["text"],
		...(resize ? { inputLimits: { ...base.inputLimits, images: { ...base.inputLimits?.images, resize } } } : {}),
	};
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model,
		streamFn: (model, context, options) => {
			// Snapshot the actual provider-facing context, not mutable agent state.
			requests.push(structuredClone(context));
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

function readSteps(file: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("read", { path: file }, { id: "read-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Inspected the supplied source.")]),
	];
}

function fakeHeadless(rendered: Buffer) {
	const svgCalls: string[] = [];
	const headless: HeadlessApi = {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unexpected browser execution"); },
		renderSvg: async (svg) => {
			svgCalls.push(svg);
			return rendered;
		},
		renderPdfPages: async () => { throw new Error("unexpected pdf render"); },
	};
	return { headless, svgCalls };
}

function assertProcessedImage(context: TranscriptContext, expected: { width: number; height: number }, raw: Buffer): void {
	const parts = images(context);
	assert.equal(parts.length, 1, "exactly one successful image reaches the faux provider");
	assert.deepEqual(dimensions(parts[0]!), expected);
	assert.ok(Buffer.byteLength(parts[0]!.data, "utf8") < 4.5 * 1024 * 1024);
	assert.notEqual(parts[0]!.data, raw.toString("base64"), "the oversized raw raster is never sent");
	assert.match(text(context), /\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by/);
}

/** The teacher with the library-rooted read as its explicit registry. */
function teacherWithRead(engine: PiEngine) {
	return createTeacherAgent(undefined, { engine, tools: { read: readToolFor(library) } });
}

// ─── read (library-rooted) ───────────────────────────────────────────────────

test("read returns an upright, resized image for an EXIF-rotated large JPEG", async () => {
	// A 12 MP landscape sensor frame tagged "rotate 90° CW" (orientation 6):
	// upright it is 3000x4000, so the default 2000px cap yields 1500x2000.
	const bytes = exifJpeg(4000, 3000, 6);
	fs.writeFileSync(path.join(library, "phone-photo.jpg"), bytes);
	const out = await readToolFor(library).execute!("exif", { path: "phone-photo.jpg" });
	const parts = out.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	const image = parts.find((part) => part.type === "image");
	assert.ok(image?.data, "the processed image is attached");
	assert.deepEqual(dimensions({ data: image.data }), { width: 1500, height: 2000 });
	assert.ok(Buffer.byteLength(image.data, "utf8") < 4.5 * 1024 * 1024);
	assert.match(parts[0]!.text!, /\[Image: original 3000x4000, displayed at 1500x2000\./);
});

test("shared teacher read detects valid image content under a non-image extension", async () => {
	const bytes = png(24, 16);
	fs.writeFileSync(path.join(library, "lecture-notes.txt"), bytes);
	const { engine, requests } = scripted(readSteps("lecture-notes.txt"));
	await teacherWithRead(engine).prompt("Inspect the supplied library file.");
	assert.equal(requests.length, 2);
	const visible = requests[1]!;
	assert.equal(images(visible).length, 1);
	assert.equal(images(visible)[0]!.mimeType, "image/png");
	assert.equal(images(visible)[0]!.data, bytes.toString("base64"));
	assert.deepEqual(dimensions(images(visible)[0]!), { width: 24, height: 16 });
	assert.match(text(visible), /Read image file \[image\/png\]/);
});

test("read of a corrupt .png yields the omitted note, not an error", async () => {
	// Valid signature/IHDR, missing pixel data: sniff succeeds, decode fails.
	const bytes = png(24, 16).subarray(0, 33);
	fs.writeFileSync(path.join(library, "corrupt.png"), bytes);
	const { engine, requests } = scripted(readSteps("corrupt.png"));
	await teacherWithRead(engine).prompt("Inspect the file.");
	assert.equal(requests.length, 2);
	assert.deepEqual(images(requests[1]!), []);
	const toolResult = requests[1]!.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult && toolResult.role === "toolResult");
	assert.equal(toolResult.isError, false);
	assert.match(text(requests[1]!), /Image omitted: could not be resized below the inline image size limit/);
	assert.ok(!JSON.stringify(requests[1]).includes(bytes.toString("base64")));
});

test("read for a text-only model attaches no image", async () => {
	fs.writeFileSync(path.join(library, "nonvision.png"), png(24, 16));
	const { engine, requests } = scripted(readSteps("nonvision.png"), undefined, false);
	await teacherWithRead(engine).prompt("Inspect the file.");
	assert.equal(requests.length, 2);
	assert.deepEqual(images(requests[1]!), [], "no image rides the tool result, whatever the transport");
	assert.match(text(requests[1]!), /\[Current model does not support images\. The image will be omitted from this request\.\]/);
});

test("teacher read binds independent active-model resize limits without mutating the shared tool", async () => {
	const bytes = png(640, 320);
	fs.writeFileSync(path.join(library, "model-bound.png"), bytes);
	const shared = readToolFor(library);
	const originalExecute = shared.execute;
	const a = scripted(readSteps("model-bound.png"), { maxWidth: 96, maxHeight: 64 });
	const b = scripted(readSteps("model-bound.png"), { maxWidth: 80, maxHeight: 30 });
	const agentA = createTeacherAgent(undefined, { engine: a.engine, tools: { read: shared } });
	const agentB = createTeacherAgent(undefined, { engine: b.engine, tools: { read: shared } });
	await agentB.prompt("Inspect with model B.");
	await agentA.prompt("Inspect with model A.");
	assertProcessedImage(a.requests[1]!, { width: 96, height: 48 }, bytes);
	assertProcessedImage(b.requests[1]!, { width: 60, height: 30 }, bytes);
	assert.equal(shared.execute, originalExecute);
});

for (const [role, resize, expected] of [
	["prober", { maxWidth: 96, maxHeight: 64 }, { width: 96, height: 48 }],
	["practice", { maxWidth: 80, maxHeight: 30 }, { width: 60, height: 30 }],
] as const) {
	test(`${role}'s actual registry retains argument healing and text reads while binding image limits`, async () => {
		const bytes = png(640, 320);
		const imageFile = `${role}-actual-registry.png`;
		const textFile = `${role}-actual-registry.txt`;
		fs.writeFileSync(path.join(library, imageFile), bytes);
		fs.writeFileSync(path.join(library, textFile), "first\nsecond\nthird\nfourth\nfifth");
		const { engine, requests } = scripted([
			fauxAssistantMessage([fauxToolCall("read", { path: imageFile }, { id: "registry-image" })], { stopReason: "toolUse" }),
			// Exact existing heal contract: schema-integer fields encoded as
			// JSON number strings heal before validation. The path stays intact.
			fauxAssistantMessage([fauxToolCall("read", { path: textFile, offset: "2", limit: "2" }, { id: "registry-text" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Inspected the image and selected text lines.")]),
		], resize);
		const forbidden = () => { throw new Error("unexpected job dispatch or handoff"); };
		const chatStore = { getChat: () => null };
		// Only context ports are mocked; no app/store imports or explicit
		// tool overrides. Job/handoff operations must never execute here.
		const agent = role === "prober"
			? createProberAgent({
				chatId: "offline-read-prober", chatStore, libraryRoot: library,
				jobStore: new Proxy({}, { get: forbidden }),
				spawn: forbidden, deliver: forbidden,
			} as never, { engine })
			: createPracticeAgent({ chatId: "offline-read-practice", chatStore, libraryRoot: library }, { engine });
		const names = agent.state.tools.map((tool) => tool.name);
		assert.ok(names.includes(role === "prober" ? "probe_done" : "problem"), "real role registry was assembled");
		const boundRead = agent.state.tools.find((tool) => tool.name === "read");
		assert.ok(boundRead?.prepareArguments, "model binding preserves the registry's prepareArguments wrapper");
		assert.deepEqual(boundRead.prepareArguments({ path: textFile, offset: "2", limit: "2" }), { path: textFile, offset: 2, limit: 2 });
		await agent.prompt("Inspect the library image, then read the selected text lines.");
		assert.equal(requests.length, 3);
		assertProcessedImage(requests[1]!, expected, bytes);
		const selected = requests[2]!.messages.find((message) => message.role === "toolResult" && message.toolCallId === "registry-text");
		assert.ok(selected && selected.role === "toolResult");
		assert.equal(selected.isError, false);
		assert.deepEqual(selected.content, [{ type: "text", text: "second\nthird\n\n[2 more lines in file. Use offset=4 to continue.]" }]);
	});
}

// ─── headless renders → visual maker ─────────────────────────────────────────

describe("headless screenshot and visual-maker outputs go through processImage", () => {
	for (const [label, resize, expected] of [
		["native defaults", undefined, { width: 2000, height: 50 }],
		["active-model overrides", CUSTOM_RESIZE, { width: 320, height: 8 }],
	] as const) {
		for (const forced of [false, true]) {
			test(`visual maker ${forced ? "forced-final" : "explicit render_svg"} path processes images using ${label}`, async () => {
				const bytes = png(4800, 120);
				const { headless, svgCalls } = fakeHeadless(bytes);
				const steps: FauxResponseStep[] = forced ? [
					fauxAssistantMessage([fauxToolCall("write_svg", { svg: SVG }, { id: "write-1" })], { stopReason: "toolUse" }),
					fauxAssistantMessage([fauxText("Premature notes without inspection.")]),
					fauxAssistantMessage([fauxText("Confirmed after inspecting the final render.")]),
				] : [
					fauxAssistantMessage([
						fauxToolCall("write_svg", { svg: SVG }, { id: "write-1" }),
						fauxToolCall("render_svg", {}, { id: "render-1" }),
					], { stopReason: "toolUse" }),
					fauxAssistantMessage([fauxText("Confirmed after inspecting the render.")]),
				];
				const { engine, requests } = scripted(steps, resize);
				const result = await runVisualMaker({ brief: "One precise synthetic figure." }, { engine, headless });
				assert.equal(requests.length, forced ? 3 : 2);
				assert.deepEqual(svgCalls, [SVG]);
				assertProcessedImage(requests.at(-1)!, expected, bytes);
				assert.equal(result.svg, SVG);
				assert.match(result.notes!, /^Confirmed after inspecting/);
				assert.equal(requests.at(-1)!.messages.at(-1)!.role, "user");
				if (forced) {
					assert.deepEqual(images(requests[1]!), [], "premature finish did not see an image yet");
					assert.match(text(requests[2]!), /You finished without looking at a render of your final SVG/);
				} else {
					assert.match(text(requests[1]!), /Here is the current render of your SVG/);
					assert.equal(requests[1]!.messages.at(-2)!.role, "toolResult");
				}
			});
		}
	}

	for (const forced of [false, true]) {
		test(`visual maker ${forced ? "forced-final" : "explicit render_svg"} processing failure never verifies or delivers the SVG`, async () => {
			const { headless, svgCalls } = fakeHeadless(Buffer.from("corrupt render"));
			const steps: FauxResponseStep[] = [
				fauxAssistantMessage([
					fauxToolCall("write_svg", { svg: SVG }, { id: "write-1" }),
					...(!forced ? [fauxToolCall("render_svg", {}, { id: "render-1" })] : []),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Unverified claim that the picture is correct.")]),
			];
			const { engine, requests } = scripted(steps);
			const activity: string[] = [];
			const result = await runVisualMaker({ brief: "One synthetic figure." }, { engine, headless, onActivity: (line) => activity.push(line) });
			assert.equal(requests.length, 2);
			assert.ok(requests.every((request) => images(request).length === 0));
			assert.equal(result.svg, "");
			assert.match(result.notes!, /^FAILED: inspecting the final SVG failed/);
			assert.match(result.notes!, /Image omitted:/);
			assert.ok(!activity.some((line) => line.includes("inspecting")), "a failed image is never marked inspected");
			assert.equal(svgCalls.length, forced ? 1 : 2, "an explicit processing failure leaves the final-SVG gate unsatisfied");
			if (!forced) assert.match(text(requests[1]!), /RENDER ERROR.*Image omitted:/);
		});
	}
});

// ─── canvas drawings (fork-only) ─────────────────────────────────────────────

const WORK_ARGS = { type: "check", nodeId: "n", question: "Sketch y = x^2", correctAnswer: "A parabola." };
const SCENE = { version: 1, objects: [{ id: "o1", type: "text", x: 10, y: 10, w: 100, h: 30, source: "note 1" }] } as never;
const DRAWING = drawingIdOf(SCENE);
const drawingMessages = (): LhMessage[] => [call("w1", "work", WORK_ARGS), result("w1", "work", null), newWorkSubmission("w1", "try", DRAWING)];

function drawingStore(canvasPng: Uint8Array): DrawingStore {
	const transcripts = new Map<string, { model: string; text: string }>();
	return {
		getScene: () => SCENE,
		getPng: () => canvasPng,
		readTranscript: (_c: string, id: string) => transcripts.get(id) ?? null,
		writeTranscript: (_c: string, id: string, t: { model: string; text: string }) => void transcripts.set(id, t),
	} as unknown as DrawingStore;
}

function llmParts(messages: LhMessage[], ctx: Awaited<ReturnType<typeof prepareDrawingContext>>) {
	const blocks = toLlmMessages(messages as never, { drawing: ctx })
		.filter((m) => m.role === "user")
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
	return {
		images: blocks.filter((b): b is ImageContent => b.type === "image"),
		text: blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n"),
	};
}

test("the drawing-context canvas PNG is processed with the session model's limits", async () => {
	const raw = png(1200, 600);
	const { engine } = scripted([], { maxWidth: 512 });
	const ctx = await prepareDrawingContext(chat("c", drawingMessages()), engine, { drawingStore: drawingStore(raw) });
	const out = llmParts(drawingMessages(), ctx);
	assert.equal(out.images.length, 1);
	const { width } = dimensions(out.images[0]!);
	assert.ok(width <= 512, `canvas image is ${width}px wide`);
	assert.notEqual(out.images[0]!.data, raw.toString("base64"));
	assert.match(out.text, /\[Image: original 1200x600, displayed at 512x256\./);
});

test("a canvas PNG that fails processing gives the session model the omitted note while the transcript still flows", async () => {
	let transcriberSaw = 0;
	const transcriber = {
		// The transcriber is stubbed here: its own processing is covered below.
		transcribe: async () => { transcriberSaw++; return { model: "faux:reader", text: "[C4] y = $x^2$" }; },
	};
	const { engine } = scripted([]);
	const ctx = await prepareDrawingContext(chat("c", drawingMessages()), engine, {
		drawingStore: drawingStore(png(24, 16).subarray(0, 33)),
		transcriber,
	});
	const out = llmParts(drawingMessages(), ctx);
	assert.equal(transcriberSaw, 1);
	assert.equal(out.images.length, 0);
	assert.match(out.text, /\[Image omitted:/);
	assert.match(out.text, /Transcription:\n\[C4\] y = \$x\^2\$/);
});

test("the drawing transcriber's PNG is processed with the transcriber model's limits", async () => {
	const raw = png(1200, 600);
	const reader = scripted([fauxAssistantMessage([fauxText("[C4] y")])], { maxWidth: 512 });
	const transcriber = createDrawingTranscriber({ engineFor: () => reader.engine });
	const out = await transcriber.transcribe(raw, "");
	assert.equal(out.text, "[C4] y");
	const sent = images(reader.requests[0]!);
	assert.equal(sent.length, 1);
	assert.ok(dimensions(sent[0]!).width <= 512);
	assert.match(text(reader.requests[0]!), /\[Image: original 1200x600, displayed at 512x256\./);
});
