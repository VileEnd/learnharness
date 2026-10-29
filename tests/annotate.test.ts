/** Unit tests - the annotate tool and the annotations fold (deterministic, no LLM). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateToolFor, annotateToolsFor, drawingIdsOfRecord } from "../src/agent/tools/annotate.ts";
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
	assert.match(text(r), /A1 to H\d+/);
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

// ---- heal parity: the record keeps RAW arguments (the tool-parts law) ----

test("annotationsOf folds a recorded call whose marks arrived as a JSON string", () => {
	const raw = { drawingId: "drw_a", marks: JSON.stringify([{ kind: "circle", target: { cell: "A1" } }]) };
	const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "s", name: "annotate", arguments: raw }] }, result("s")];
	assert.deepEqual(annotationsOf(messages, "drw_a"), [{ callId: "s", marks: [{ kind: "circle", target: { cell: "A1" } }] }]);
});

test("a stringified nested target and null optional fields heal at the boundary and in the record alike", async () => {
	const raw = { drawingId: "drw_a", marks: [{ kind: "arrow", from: '{"object":"o1"}', to: { cell: "C4" }, target: null, label: null }] };
	const tools = createTeacherTools({
		chatId: "c1", chatStore: { getChat: () => null } as never, jobStore: {} as never, spawn: () => {}, libraryRoot: "/tmp",
		canvas: true, drawingStore: store("c1", "drw_a"),
	} as never);
	const prepared = tools.annotate!.prepareArguments!(raw) as { marks: { from: unknown }[] };
	assert.deepEqual(prepared.marks[0]!.from, { object: "o1" });
	const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "n", name: "annotate", arguments: raw }] }, result("n")];
	assert.deepEqual(annotationsOf(messages, "drw_a"), [{ callId: "n", marks: [{ kind: "arrow", from: { object: "o1" }, to: { cell: "C4" } }] }]);
});

// ---- range spelling: the structured text writes spans with a dash ----

test("a dash, an en dash or a range in cell resolves like the colon range", async () => {
	const colon = resolveTargetRect({ cells: "A1:C1" }, scene, box);
	assert.ok(colon);
	assert.deepEqual(resolveTargetRect({ cells: "A1-C1" }, scene, box), colon);
	assert.deepEqual(resolveTargetRect({ cells: "A1–C1" }, scene, box), colon);
	assert.deepEqual(resolveTargetRect({ cell: "A1-C1" }, scene, box), colon);
	const r = await run(tool, { drawingId: "drw_a", marks: [{ kind: "underline", target: { cells: "A1-C1" } }, { kind: "circle", target: { cell: "A1:B1" } }] });
	assert.equal(r.isError, undefined);
});

test("a malformed range is refused with the range syntax", async () => {
	const r = await run(tool, { drawingId: "drw_a", marks: [{ kind: "underline", target: { cells: "A1..C1" } }] });
	assert.equal(r.isError, true);
	assert.match(text(r), /ranges are written B2:D3/);
});

// ---- RC1: forgiving mark shapes (heal parity at the boundary and in the record) ----

const teacherTools = () =>
	createTeacherTools({
		chatId: "c1", chatStore: { getChat: () => null } as never, jobStore: {} as never, spawn: () => {}, libraryRoot: "/tmp",
		canvas: true, drawingStore: store("c1", "drw_a"),
	} as never);
const recorded = (id: string, marks: unknown[]) => [
	{ role: "assistant", content: [{ type: "toolCall", id, name: "annotate", arguments: { drawingId: "drw_a", marks } }] },
	result(id),
];

test("Kimi's {kind:cross, from:{object}} heals into a target, annotates, and folds alike from the raw record", async () => {
	const raw = { drawingId: "drw_a", marks: [{ kind: "cross", from: { object: "o2" } }] };
	const prepared = teacherTools().annotate!.prepareArguments!(raw) as { marks: unknown[] };
	assert.deepEqual(prepared.marks, [{ kind: "cross", target: { object: "o2" } }]);
	assert.match(text(await run(tool, prepared)), /Annotated 1 mark/);
	assert.deepEqual(annotationsOf(recorded("k", raw.marks), "drw_a"), [{ callId: "k", marks: [{ kind: "cross", target: { object: "o2" } }] }]);
});

test("a lone `to` on a non-arrow mark heals the same way", () => {
	const prepared = teacherTools().annotate!.prepareArguments!({ drawingId: "drw_a", marks: [{ kind: "circle", to: { cell: "A1" } }] }) as { marks: unknown[] };
	assert.deepEqual(prepared.marks, [{ kind: "circle", target: { cell: "A1" } }]);
});

test("Haiku's bare cells/cell/object key on the mark is wrapped into target, at the boundary and in the record", async () => {
	for (const [bare, target] of [[{ cells: "D3:D4" }, { cells: "D3:D4" }], [{ cell: "C4" }, { cell: "C4" }], [{ object: "o1" }, { object: "o1" }]] as const) {
		const marks = [{ kind: "check", ...bare }];
		const prepared = teacherTools().annotate!.prepareArguments!({ drawingId: "drw_a", marks }) as { marks: unknown[] };
		assert.deepEqual(prepared.marks, [{ kind: "check", target }]);
		assert.match(text(await run(tool, prepared)), /Annotated 1 mark/);
		assert.deepEqual(annotationsOf(recorded("h", marks), "drw_a"), [{ callId: "h", marks: [{ kind: "check", target }] }]);
	}
});

test("an arrow keeps from/to; an arrow with only a target is still refused", async () => {
	const arrow = { kind: "arrow", from: { object: "o1" }, to: { cell: "C4" } };
	const prepared = teacherTools().annotate!.prepareArguments!({ drawingId: "drw_a", marks: [arrow] }) as { marks: unknown[] };
	assert.deepEqual(prepared.marks, [arrow]);
	const refused = await run(tool, teacherTools().annotate!.prepareArguments!({ drawingId: "drw_a", marks: [{ kind: "arrow", target: { object: "o1" } }] }) as never);
	assert.equal((refused as { isError?: boolean }).isError, true);
	assert.match(text(refused), /from is missing/);
	assert.equal(annotationsOf(recorded("a", [{ kind: "arrow", target: { object: "o1" } }]), "drw_a").length, 0);
});

test("both from and to on a non-arrow mark is refused, naming the rename", async () => {
	const r = await run(tool, { drawingId: "drw_a", marks: [{ kind: "cross", from: { object: "o1" }, to: { object: "o2" } }] });
	assert.equal((r as { isError?: boolean }).isError, true);
	assert.match(text(r), /only arrows take from\/to - rename `from` to `target`/);
});

// ---- stroke targets (M5) ----

const strokeScene: DrawingScene = {
	version: 1,
	objects: [
		{ id: "o1", z: 0, type: "text", x: 0, y: 0, w: 100, h: 40, source: "x" },
		{ id: "s4", z: 1, type: "stroke", brush: "pen", color: "blue", size: 3, points: [[10, 20, 1], [30, 80, 1], [20, 60, 1]] },
		{ id: "s5", z: 2, type: "stroke", brush: "pen", color: "red", size: 3, points: [] },
	],
};
const strokeTool = annotateToolFor({ chatId: "c1", drawingStore: { getScene: () => strokeScene } });

test("annotate resolves a stroke target to the stroke's bounding rect", async () => {
	assert.deepEqual(resolveTargetRect({ stroke: "s4" }, strokeScene, sceneBoundingBox(strokeScene)!), { x: 10, y: 20, w: 20, h: 60 });
	const r = await run(strokeTool, { drawingId: "drw_a", marks: [{ kind: "circle", target: { stroke: "s4" } }] });
	assert.equal(r.isError, undefined);
});

test("annotate refuses an unknown stroke id and lists the valid ones; empty strokes do not resolve", async () => {
	const r = await run(strokeTool, { drawingId: "drw_a", marks: [{ kind: "circle", target: { stroke: "s9" } }] });
	assert.equal(r.isError, true);
	assert.match(text(r), /s9/);
	assert.match(text(r), /stroke ids: s4\b/);
	assert.doesNotMatch(text(r), /s5/);
	assert.equal(resolveTargetRect({ stroke: "s5" }, strokeScene, sceneBoundingBox(strokeScene)!), null);
	assert.equal(resolveTargetRect({ object: "s5" }, strokeScene, sceneBoundingBox(strokeScene)!), null);
});

test("the refusal's stroke-id list is capped like the digest (the ids the model can see), with a +N tail", async () => {
	// Final review (M5 #2): the stroke-id list in a refusal was uncapped.
	const objects = Array.from({ length: 45 }, (_, i) => ({
		id: `s${i + 1}`, z: i, type: "stroke" as const, brush: "pen" as const, color: "ink", size: 3,
		points: [[10 * i, 0, 1], [10 * i, i === 44 ? 400 : 5, 1]] as [number, number, number][],
	}));
	const many: DrawingScene = { version: 1, objects };
	const t = annotateToolFor({ chatId: "c1", drawingStore: { getScene: () => many } });
	const r = await run(t, { drawingId: "drw_a", marks: [{ kind: "circle", target: { stroke: "s99" } }] });
	assert.equal(r.isError, true);
	const listed = /stroke ids: ([^;\n]*)/.exec(text(r))![1]!;
	assert.equal(listed.match(/\bs\d+\b/g)!.length, 40);
	assert.match(listed, /\bs45\b/, "the longest stroke is listed");
	assert.match(listed, /\+5 more/);
	// A valid id outside the listed set still resolves (the cap limits the hint, never the target).
	assert.doesNotMatch(listed, /\bs44\b/, "an equal-length tick past the cap is left out (ties by id)");
	const ok = await run(t, { drawingId: "drw_a", marks: [{ kind: "circle", target: { stroke: "s44" } }] });
	assert.equal(ok.isError, undefined);
});

test("a bare stroke key on a mark heals into a target, and the fold reads it", () => {
	const raw = { drawingId: "drw_a", marks: [{ kind: "circle", stroke: "s4" }] };
	const prepared = strokeTool.prepareArguments!(raw) as { marks: { target: unknown }[] };
	assert.deepEqual(prepared.marks[0]!.target, { stroke: "s4" });
});

test("a hint snapshot's drawing is markable: drawingIdsOfRecord counts it", () => {
	const hint = { role: "custom", customType: "hint-request", details: { callId: "w1", n: 1, drawingId: "drw_h" } };
	assert.deepEqual(drawingIdsOfRecord([hint]), ["drw_h"]);
});
