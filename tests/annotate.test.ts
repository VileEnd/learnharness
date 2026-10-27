/** Unit tests - the annotate tool and the annotations fold (deterministic, no LLM). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateToolFor, annotateToolsFor } from "../src/agent/tools/annotate.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { annotationsOf, resolveTargetRect, sceneBoundingBox, type DrawingScene } from "../src/core/canvas-core.ts";

const scene: DrawingScene = {
	version: 1,
	objects: [
		{ id: "o1", z: 0, type: "text", x: 0, y: 0, w: 100, h: 40, source: "x = 2" },
		{ id: "o2", z: 1, type: "latex", x: 0, y: 200, w: 100, h: 40, source: "x^2" },
	],
};
const box = sceneBoundingBox(scene)!;
const store = (chat: string, id: string) => ({ getScene: (c: string, d: string) => (c === chat && d === id ? scene : null) });
const tool = annotateToolFor({ chatId: "c1", drawingStore: store("c1", "drw_a") });
const run = (t: typeof tool, input: unknown) => t.execute("call1", input as never, undefined as never);
const text = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;

test("annotate rejects unknown object id", async () => {
	const r = await run(tool, { drawingId: "drw_a", marks: [{ kind: "circle", target: { object: "o9" } }] });
	assert.equal(r.isError, true);
	assert.match(text(r), /o9/);
	assert.match(text(r), /o1, o2/); // names the valid ids
});

test("annotate rejects out-of-grid cell", async () => {
	const r = await run(tool, { drawingId: "drw_a", marks: [{ kind: "check", target: { cell: "Z99" } }] });
	assert.equal(r.isError, true);
	assert.match(text(r), /A1-H\d+/);
});

test("annotate accepts cell range and arrows", async () => {
	const r = await run(tool, {
		drawingId: "drw_a",
		marks: [{ kind: "underline", target: { cells: "B2:D3" } }, { kind: "arrow", from: { object: "o1" }, to: { cell: "C4" }, label: "here" }],
	});
	assert.equal(r.isError, undefined);
	assert.equal(text(r), "Annotated 2 marks.");
});

test("annotate on another chat's drawing refused, naming this chat's drawings", async () => {
	const other = annotateToolFor({
		chatId: "c2",
		drawingStore: store("c1", "drw_a"),
		chatStore: { getChat: () => ({ messages: [{ role: "custom", customType: "work-submission", details: { drawingId: "drw_mine" } }] }) },
	});
	const r = await run(other, { drawingId: "drw_a", marks: [{ kind: "circle", target: { cell: "A1" } }] });
	assert.equal(r.isError, true);
	assert.match(text(r), /drw_mine/);
});

test("resolveTargetRect cell range spans cells", () => {
	const a = resolveTargetRect({ cell: "B2" }, scene, box)!;
	const d = resolveTargetRect({ cells: "B2:D3" }, scene, box)!;
	assert.ok(d.w > a.w * 2.9 && d.h > a.h * 1.9);
	assert.equal(d.x, a.x);
	assert.deepEqual(resolveTargetRect({ cells: "D3:B2" }, scene, box), d); // order-insensitive
	assert.equal(resolveTargetRect({ cell: "Z99" }, scene, box), null);
	assert.deepEqual(resolveTargetRect({ object: "o1" }, scene, box), { x: 0, y: 0, w: 100, h: 40 });
});

const call = (id: string, drawingId: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "annotate", arguments: { drawingId, marks: [{ kind: "circle", target: { cell: "A1" } }] } }],
});
const result = (id: string, extra: object = {}) => ({ role: "toolResult", toolCallId: id, toolName: "annotate", content: [], ...extra });

test("annotationsOf derives marks from record only and ignores failed calls", () => {
	const messages = [
		call("ok", "drw_a"), result("ok"),
		call("err", "drw_a"), result("err", { isError: true }),
		call("nok", "drw_a"), result("nok", { details: { ok: false } }),
		call("dangling", "drw_a"),
		call("other", "drw_b"), result("other"),
	];
	const got = annotationsOf(messages, "drw_a");
	assert.deepEqual(got.map((g) => g.callId), ["ok"]);
	assert.equal(got[0]!.marks.length, 1);
	// Independent of any drawing file: the fold takes the record only.
	assert.deepEqual(annotationsOf(messages, "drw_a"), got);
});

test("annotate registers on canvas turns or when the record holds a drawing", () => {
	const empty = { getChat: () => ({ messages: [] }) };
	const withDrawing = { getChat: () => ({ messages: [{ role: "custom", details: { drawingId: "drw_a" } }] }) };
	const ds = store("c1", "drw_a");
	assert.deepEqual(Object.keys(annotateToolsFor({ chatId: "c1", chatStore: empty, drawingStore: ds })), []);
	assert.deepEqual(Object.keys(annotateToolsFor({ chatId: "c1", chatStore: empty, drawingStore: ds, canvas: true })), ["annotate"]);
	assert.deepEqual(Object.keys(annotateToolsFor({ chatId: "c1", chatStore: withDrawing, drawingStore: ds })), ["annotate"]);
	assert.deepEqual(Object.keys(annotateToolsFor({ chatId: "c1", chatStore: withDrawing })), []);
});

test("a stringified marks array is healed before validation", async () => {
	const tools = createTeacherTools({
		chatId: "c1", chatStore: { getChat: () => null } as never, jobStore: {} as never, spawn: () => {}, libraryRoot: "/tmp",
		canvas: true, drawingStore: store("c1", "drw_a"),
	} as never);
	const t = tools.annotate!;
	const args = t.prepareArguments!({ drawingId: "drw_a", marks: JSON.stringify([{ kind: "circle", target: { cell: "A1" } }]) }) as { marks: unknown };
	assert.ok(Array.isArray(args.marks));
});
