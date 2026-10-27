/**
 * THE CANVAS SURFACE (PR 2) - SSR render pins and pure seams: the work dock (open-canvas on a tablet, the
 * text fallback on a phone), the Canvas pill (hidden on a phone, off by default in a draft, reflecting the
 * session setting), the submission card's thumbnail, the draft merge (pickDraft), the dock priority, the
 * draft-session create call, the practice `canvas` refusal, and the closing grade's reveal.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkDock } from "../components/work-dock.tsx";
import { CanvasPill } from "../components/model-picker.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import { DrawingThumb, WorkSubmissionCard, drawingPngUrl } from "../components/work-cards.tsx";
import { GradeChip } from "../components/artifacts/grade-chip.tsx";
import { canSubmitWork, CanvasWorkspace } from "../components/canvas/canvas-workspace.tsx";
import { pickDraft } from "../components/canvas/draft.ts";
import { tableAddCol, tableAddRow, tableNextCell, tableRemoveCol, tableRemoveRow } from "../components/canvas/object-edit.ts";
import { isCanvasCapable } from "../components/use-canvas-capable.ts";
import { startDraftSession } from "../components/new-session.tsx";
import { canvasTargetOf, dockKindOf } from "../components/chat.tsx";
import { createPracticeGate, problemTool } from "../src/agent/tools/practice.ts";
import { projectView } from "../src/core/view.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { DrawingScene } from "../src/core";

const noop = () => {};
const dock = (over: Partial<React.ComponentProps<typeof WorkDock>> = {}) =>
	renderToStaticMarkup(
		<WorkDock chatId="c1" callId="call_w" question="Sketch the free-body diagram." active requiresReveal={false} canvasCapable onOpenCanvas={noop} onSubmit={noop} onHint={noop} onDismiss={noop} {...over} />,
	);

const sceneOf = (n: number): DrawingScene => ({
	version: 1,
	objects: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, z: i, type: "stroke" as const, brush: "pen" as const, color: "ink", size: 4, points: [[0, 0, 0.5] as [number, number, number]] })),
});

describe("WorkDock", () => {
	it("renders open-canvas and the text fallback", () => {
		const html = dock();
		assert.match(html, /data-testid="open-canvas"/);
		assert.match(html, /data-testid="work-thinking-field"/);
		assert.match(html, /Sketch the free-body diagram\./);
		assert.match(html, /data-testid="work-hint"/);
		assert.match(html, /data-testid="work-send"/);
	});

	it("phone fallback: no open-canvas, the hint text instead, the field stays", () => {
		const html = dock({ canvasCapable: false });
		assert.ok(!html.includes('data-testid="open-canvas"'));
		assert.match(html, /Draw on a tablet or computer/);
		assert.match(html, /data-testid="work-thinking-field"/);
	});

	it("a teach check arrives behind the reveal bar", () => {
		const html = dock({ requiresReveal: true });
		assert.match(html, /data-testid="work-dock-reveal"/);
		assert.ok(!html.includes('data-testid="open-canvas"'));
	});
});

describe("CanvasPill", () => {
	it("hidden when not canvas-capable", () => {
		assert.equal(renderToStaticMarkup(<CanvasPill capable={false} />), "");
		// SSR / first paint is never capable (useCanvasCapable's server snapshot is false).
		assert.equal(renderToStaticMarkup(<CanvasPill />), "");
		assert.ok(!renderToStaticMarkup(<StatsBar turns={[]} />).includes("stats-canvas"));
	});

	it("off by default in a draft", () => {
		const html = renderToStaticMarkup(<CanvasPill capable />);
		assert.match(html, /data-testid="stats-canvas"/);
		assert.match(html, /aria-pressed="false"/);
	});

	it("reflects the session setting", () => {
		const html = renderToStaticMarkup(<CanvasPill capable chatId="c1" value />);
		assert.match(html, /aria-pressed="true"/);
	});

	it("capability is the PHYSICAL screen's short side, at least 600", () => {
		assert.equal(isCanvasCapable({ width: 390, height: 844 }), false);
		assert.equal(isCanvasCapable({ width: 820, height: 1180 }), true);
		assert.equal(isCanvasCapable({ width: 1180, height: 820 }), true);
		assert.equal(isCanvasCapable({ width: 599, height: 2000 }), false);
		assert.equal(isCanvasCapable(undefined), false);
	});
});

describe("startDraftSession", () => {
	it("sends canvas when the draft pill is on, and nothing when off", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({ id: "chat_new" });
		}) as typeof fetch;
		await startDraftSession("Teach me torque", fakeFetch, undefined, undefined, true);
		await startDraftSession("Teach me torque", fakeFetch);
		assert.deepEqual(bodies[0], { title: "Teach me torque", canvas: true });
		assert.deepEqual(bodies[1], { title: "Teach me torque" });
	});
});

describe("cards", () => {
	it("WorkSubmissionCard shows the thumbnail url and the text", () => {
		const html = renderToStaticMarkup(<WorkSubmissionCard chatId="c1" data={{ workCallId: "call_w", text: "I drew the forces.", drawingId: "drw_abc123def456" }} />);
		assert.match(html, /data-testid="drawing-thumb"/);
		assert.ok(html.includes(drawingPngUrl("c1", "drw_abc123def456")));
		assert.ok(html.includes("/api/chats/c1/drawings/drw_abc123def456?format=png"));
		assert.match(html, /I drew the forces\./);
	});

	it("a text-only submission has no thumbnail; an absent drawing renders nothing", () => {
		const html = renderToStaticMarkup(<WorkSubmissionCard chatId="c1" data={{ workCallId: "call_w", text: "Just words." }} />);
		assert.ok(!html.includes("drawing-thumb"));
		assert.equal(renderToStaticMarkup(<DrawingThumb chatId="c1" />), "");
	});

	it("a grade closing a canvas task reveals the committed correctAnswer; other grades do not", () => {
		const posed = (name: string, id: string, args: Record<string, unknown>): LhMessage[] => [
			{ id: `a_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 1 } as unknown as LhMessage,
			{ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 } as unknown as LhMessage,
		];
		const grade = (id: string, question: string): LhMessage => ({ id: `g_${id}`, role: "assistant", content: [{ type: "toolCall", id, name: "grade", arguments: { question, grade: "correct" } }], stopReason: "stop", timestamp: 3 } as unknown as LhMessage);
		const messages = [...posed("work", "call_w", { question: "Q", correctAnswer: "Two arrows, equal length." }), grade("call_g", "call_w")];
		const view = projectView(messages);
		const gradePart = view.flatMap((m) => m.parts).find((p) => p.type === "tool-grade");
		assert.equal(gradePart?.reveal, "Two arrows, equal length.");
		const html = renderToStaticMarkup(<GradeChip part={gradePart as never} />);
		assert.match(html, /data-testid="grade-reveal"/);
		assert.match(html, /Two arrows, equal length\./);
		// A grade on a quiz call reveals nothing.
		const other = projectView([...posed("quiz", "call_q", { question: "Q" }), grade("call_g2", "call_q")]).flatMap((m) => m.parts).find((p) => p.type === "tool-grade");
		assert.equal(other?.reveal, undefined);
		assert.ok(!renderToStaticMarkup(<GradeChip part={other as never} />).includes("grade-reveal"));
	});
});

describe("canvas workspace seams", () => {
	it("local draft wins when newer (pickDraft)", () => {
		const server = { scene: sceneOf(1), rev: 3 };
		const unsynced = { scene: sceneOf(2), rev: 3, dirty: true };
		assert.equal(pickDraft(server, unsynced)?.from, "local", "unacknowledged local edits on the server's revision win");
		assert.equal(pickDraft(server, unsynced)?.rev, 3, "and are saved against the server's current revision");
		assert.equal(pickDraft(server, { scene: sceneOf(2), rev: 2, dirty: true })?.from, "server", "another device moved on: the server wins");
		assert.equal(pickDraft(server, { scene: sceneOf(2), rev: 3, dirty: false })?.from, "server", "a clean mirror never beats the server");
		assert.equal(pickDraft(null, unsynced)?.from, "local", "offline from the start: the mirror carries it");
		assert.equal(pickDraft(server, null)?.from, "server");
		assert.equal(pickDraft(null, null), null);
	});

	it("requireThinking gates Submit; an empty scene submits text only", () => {
		assert.equal(canSubmitWork({ text: "", objectCount: 3, requireThinking: true, busy: false }), false);
		assert.equal(canSubmitWork({ text: "  ", objectCount: 3, requireThinking: true, busy: false }), false);
		assert.equal(canSubmitWork({ text: "because", objectCount: 3, requireThinking: true, busy: false }), true);
		assert.equal(canSubmitWork({ text: "", objectCount: 3, requireThinking: false, busy: false }), true);
		assert.equal(canSubmitWork({ text: "words only", objectCount: 0, requireThinking: false, busy: false }), true);
		assert.equal(canSubmitWork({ text: "", objectCount: 0, requireThinking: false, busy: false }), false, "nothing to submit");
		assert.equal(canSubmitWork({ text: "x", objectCount: 1, requireThinking: false, busy: true }), false);
	});

	it("the workspace shell: question strip, toolbar tools, palette, Hint and Submit", () => {
		const html = renderToStaticMarkup(<CanvasWorkspace chatId="c1" callId="call_w" question="Draw the circuit." requireThinking onSubmit={noop} onHint={noop} onMinimize={noop} />);
		assert.match(html, /data-testid="canvas-workspace"/);
		assert.match(html, /Draw the circuit\./);
		for (const t of ["select", "pan", "pen", "pencil", "marker", "line", "arrow", "rect", "ellipse", "eraser", "text", "markdown", "latex", "table", "image"]) {
			assert.ok(html.includes(`data-testid="canvas-tool-${t}"`), `tool ${t}`);
		}
		assert.equal((html.match(/data-testid="canvas-color-/g) ?? []).length, 8);
		assert.match(html, /data-testid="canvas-undo"/);
		assert.match(html, /data-testid="canvas-redo"/);
		assert.match(html, /data-testid="canvas-zoom-reset"/);
		assert.match(html, /data-testid="canvas-minimize"/);
		assert.match(html, /Your thinking \(required\)/);
		assert.match(html, /data-testid="canvas-hint"/);
		assert.match(html, /data-testid="canvas-submit"[^>]*disabled/, "Submit starts disabled (nothing to submit yet)");
		assert.ok(!html.includes("fixed inset-0"), "mounted in the session area, never fixed inset-0");
	});

	it("table edits: add/remove row and column, Tab walks reading order", () => {
		const t = [["a", "b"], ["c", "d"]];
		assert.deepEqual(tableAddRow(t), [["a", "b"], ["c", "d"], ["", ""]]);
		assert.deepEqual(tableAddCol(t), [["a", "b", ""], ["c", "d", ""]]);
		assert.deepEqual(tableRemoveRow(t, 0), [["c", "d"]]);
		assert.deepEqual(tableRemoveCol(t, 1), [["a"], ["c"]]);
		assert.deepEqual(tableRemoveRow([["x"]], 0), [["x"]], "the last row stays");
		assert.deepEqual(tableNextCell(t, 0, 1, false), { r: 1, c: 0 });
		assert.deepEqual(tableNextCell(t, 1, 0, true), { r: 0, c: 1 });
		assert.equal(tableNextCell(t, 1, 1, false), null);
	});
});

describe("dock priority and the canvas target", () => {
	it("side question takes the dock over an open work task", () => {
		assert.equal(dockKindOf({ pending: true, work: true, practice: false }), "question");
		assert.equal(dockKindOf({ pending: false, work: true, practice: false }), "work", "the work dock returns once the question is answered");
		assert.equal(dockKindOf({ pending: false, work: false, practice: true }), "practice");
		assert.equal(dockKindOf({ pending: false, work: false, practice: false }), "composer");
	});

	it("the workspace subject: an open task, or a practice problem posed with canvas", () => {
		assert.equal(canvasTargetOf(null, null), null);
		assert.equal(canvasTargetOf(null, { toolCallId: "p1", input: { statement: "S" } }), null, "a plain practice problem has no canvas");
		assert.deepEqual(canvasTargetOf(null, { toolCallId: "p1", input: { statement: "S", canvas: true } }), { kind: "practice", callId: "p1", question: "S" });
		assert.deepEqual(canvasTargetOf({ toolCallId: "w1", input: { question: "Q", details: "D", requireThinking: true } }, null), { kind: "work", callId: "w1", question: "Q", details: "D", requireThinking: true });
	});
});

describe("practice canvas problems", () => {
	const input = { statement: "Sketch the field lines.", mode: "recall", modelSolution: "Lines leave +, enter -.", canvas: true } as never;
	const gate = () => createPracticeGate({ chatId: "c", chatStore: { getChat: () => null } } as never);

	it("practice problem canvas refused when session canvas off", async () => {
		const refused = await problemTool(gate()).execute("call_x", input);
		assert.equal(refused.isError, true);
		assert.match(JSON.stringify(refused.content), /canvas/);
	});

	it("accepted when the session canvas is on", async () => {
		const ok = await problemTool(gate(), undefined, undefined, true).execute("call_x", input);
		assert.equal(ok.isError, undefined);
	});
});
