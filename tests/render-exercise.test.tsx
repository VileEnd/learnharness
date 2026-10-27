/**
 * Exercise widgets, attempt loop and hints (interactive exercises, PR 1).
 * Static-markup tests (no DOM): state-dependent views are reached through the
 * pure reducer and the components' initial-state seams.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExerciseWidget } from "../components/exercise/exercise-widget.tsx";
import { UnreadableNotice } from "../components/exercise/widget-shared.tsx";
import {
	emptyResponse,
	exerciseAttemptReducer,
	initialAttemptState,
	type ExerciseAttemptState,
} from "../components/exercise/attempt-state.ts";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ConcludeCard, ThinkingCard } from "../components/practice-cards.tsx";
import { buildExerciseAnswer } from "../src/core/question-core.ts";
import { gradeExercise, stripExpected, type InteractiveFormat } from "../src/core/exercise-core.ts";

const numericSpec = { answer: "42", mode: "number" as const };
const blanksSpec = {
	text: "Water boils at {{t}} degrees and freezes at {{f}}.",
	blanks: [
		{ id: "t", accept: ["100"], mode: "number" as const },
		{ id: "f", accept: ["zero"] },
	],
};
const tableSpec = {
	columns: ["x", "x squared"],
	rows: [
		{ cells: [{ given: "2" }, { id: "r1", accept: ["4"], mode: "number" as const }] },
		{ cells: [{ given: "3" }, { id: "r2", accept: ["9"], mode: "number" as const }] },
	],
};
const multipartSpec = {
	parts: [
		{ id: "a", label: "Part A", format: "numeric" as const, spec: numericSpec },
		{ id: "b", label: "Part B", format: "blanks" as const, spec: blanksSpec },
	],
};
const specs: Record<string, unknown> = { numeric: numericSpec, blanks: blanksSpec, table: tableSpec, multipart: multipartSpec };

function exerciseInput(format: InteractiveFormat, extra: Record<string, unknown> = {}) {
	return {
		question: "Work it out",
		format,
		explanation: "Because maths.",
		spec: specs[format],
		hints: ["Think about units.", "Try the obvious operation.", "Almost there."],
		...extra,
	};
}

const noop = () => {};
/** Visible markup: the ✓/✗ glyph paths are numbers that would match any digit probe. */
const noSvg = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "");

describe("exercise widgets", () => {
	for (const format of ["numeric", "blanks", "table", "multipart"] as const) {
		it(`${format} renders an input state`, () => {
			const html = renderToStaticMarkup(
				<ExerciseWidget format={format} spec={specs[format]} toolCallId="c1" value={emptyResponse(format, specs[format])} onChange={noop} />,
			);
			assert.match(html, new RegExp(`data-testid="exercise-${format}"`));
			assert.match(html, /<input/);
			assert.doesNotMatch(html, /data-correct/);
		});
		it(`${format} review marks wrong items`, () => {
			const verdict = gradeExercise(format, specs[format], {});
			const html = renderToStaticMarkup(
				<ExerciseWidget format={format} spec={specs[format]} toolCallId="c1" value={{}} onChange={noop} readOnly review={verdict} />,
			);
			assert.match(html, /data-correct="false"/);
		});
	}

	it("blanks given text is read-only markup around inline inputs", () => {
		const html = renderToStaticMarkup(
			<ExerciseWidget format="blanks" spec={blanksSpec} toolCallId="c1" value={emptyResponse("blanks", blanksSpec)} onChange={noop} />,
		);
		assert.match(html, /Water boils at/);
		assert.equal((html.match(/<input/g) ?? []).length, 2);
	});

	it("a blank inside a math span keeps the span whole so KaTeX renders it", () => {
		const spec = { text: "Solve $2 + {{a}} = 5$ now.", blanks: [{ id: "a", accept: ["3"], mode: "number" as const }] };
		const html = renderToStaticMarkup(
			<ExerciseWidget format="blanks" spec={spec} toolCallId="c1" value={emptyResponse("blanks", spec)} onChange={noop} />,
		);
		assert.match(html, /katex/);
		assert.doesNotMatch(html, /\$/);
		assert.equal((html.match(/<input/g) ?? []).length, 1);
	});

	it("a blank inside math leaves no placeholder glyph next to the input", () => {
		for (const text of ["Then $P(\\text{positive}) = {{a}}$ holds.", "Then $2 + {{a}} = 5$ holds."]) {
			const spec = { text, blanks: [{ id: "a", accept: ["3"], mode: "number" as const }] };
			const html = renderToStaticMarkup(
				<ExerciseWidget format="blanks" spec={spec} toolCallId="c1" value={emptyResponse("blanks", spec)} onChange={noop} />,
			);
			assert.doesNotMatch(html, /\\square|\u25a1|\u25fb/);
			assert.doesNotMatch(html, /katex-error/);
			assert.equal((html.match(/<input/g) ?? []).length, 1);
		}
	});

	it("table cells shrink and overlay the mark so a phone-width table fits", () => {
		const verdict = gradeExercise("table", tableSpec, {});
		const html = renderToStaticMarkup(
			<ExerciseWidget format="table" spec={tableSpec} toolCallId="c1" value={{}} onChange={noop} readOnly review={verdict} />,
		);
		assert.match(html, /table-fixed/);
		assert.match(html, /<input[^>]*class="[^"]*\bmin-w-0\b[^"]*\bw-full\b/);
		assert.match(html, /<span[^>]*class="[^"]*\babsolute\b[^"]*"[^>]*data-mark|data-mark="x"[^>]*class="[^"]*\babsolute\b/);
	});

	it("a table review does not repeat the filled-in table under Why", () => {
		const input = exerciseInput("table", { explanation: "Filled in:\n\n| x | y |\n| --- | --- |\n| 2 | 4 |\n\nSquare it." });
		const answer = buildExerciseAnswer(input as never, { values: { r1: "4", r2: "9" } }, { attempts: 1, hintsUsed: 0, gaveUp: false }, "exercise");
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
		assert.doesNotMatch(html, /Filled in/);
		assert.match(html, /Square it/);
		assert.equal((html.match(/<table/g) ?? []).length, 1);
	});

	it("table renders given cells read-only and editable cells as inputs", () => {
		const html = renderToStaticMarkup(
			<ExerciseWidget format="table" spec={tableSpec} toolCallId="c1" value={emptyResponse("table", tableSpec)} onChange={noop} />,
		);
		assert.equal((html.match(/<input/g) ?? []).length, 2);
		assert.match(html, /<table/);
	});

	it("multipart renders a labelled section per part", () => {
		const html = renderToStaticMarkup(
			<ExerciseWidget format="multipart" spec={multipartSpec} toolCallId="c1" value={emptyResponse("multipart", multipartSpec)} onChange={noop} />,
		);
		assert.match(html, /Part A/);
		assert.match(html, /Part B/);
		assert.match(html, /data-testid="exercise-numeric"/);
		assert.match(html, /data-testid="exercise-blanks"/);
	});

	it("marksOnly hides the expected value, a full review shows it", () => {
		const verdict = gradeExercise("numeric", numericSpec, { value: "7" });
		const full = renderToStaticMarkup(
			<ExerciseWidget format="numeric" spec={numericSpec} toolCallId="c1" value={{ value: "7" }} onChange={noop} readOnly review={verdict} />,
		);
		assert.match(noSvg(full), /42/);
		const marks = renderToStaticMarkup(
			<ExerciseWidget format="numeric" spec={numericSpec} toolCallId="c1" value={{ value: "7" }} onChange={noop} review={verdict} marksOnly />,
		);
		assert.match(marks, /data-correct="false"/);
		assert.doesNotMatch(noSvg(marks), /42/);
	});
});

describe("exercise attempt loop", () => {
	const wrong = gradeExercise("numeric", numericSpec, { value: "7" });
	const right = gradeExercise("numeric", numericSpec, { value: "42" });

	it("check shows marks without the key", () => {
		const state: ExerciseAttemptState = exerciseAttemptReducer(
			initialAttemptState({ value: "7" }),
			{ type: "check", verdict: wrong, confidence: 80 },
		);
		assert.equal(state.attempts, 1);
		assert.equal(state.submitting, false);
		assert.ok(state.verdict);
		assert.ok(state.verdict.items.every((i) => i.expected === undefined));
		const html = renderToStaticMarkup(
			<QuestionDock toolName="exercise" toolCallId="c1" input={exerciseInput("numeric") as never} expanded onExpand={noop} onSubmit={noop} initialAttempt={state} />,
		);
		assert.match(html, /data-correct="false"/);
		assert.doesNotMatch(noSvg(html), /42/);
	});

	it("first attempt is captured once; a correct check submits", () => {
		const s1 = exerciseAttemptReducer(initialAttemptState({ value: "7" }), { type: "check", verdict: wrong, confidence: 90 });
		const s2 = exerciseAttemptReducer(exerciseAttemptReducer(s1, { type: "edit", response: { value: "42" } }), { type: "check", verdict: right, confidence: 50 });
		assert.equal(s2.attempts, 2);
		assert.equal(s2.firstAttempt?.verdict.outcome, "wrong");
		assert.equal(s2.firstAttempt?.confidence, 90);
		assert.equal(s2.submitting, true);
		assert.equal(s1.submitting, false);
	});

	it("hints reveal one at a time", () => {
		let s = initialAttemptState({ value: "" });
		let html = renderToStaticMarkup(
			<QuestionDock toolName="exercise" toolCallId="c1" input={exerciseInput("numeric") as never} expanded onExpand={noop} onSubmit={noop} initialAttempt={s} />,
		);
		assert.match(html, /Hint \(3 left\)/);
		assert.doesNotMatch(html, /Think about units/);
		s = exerciseAttemptReducer(s, { type: "hint", total: 3 });
		html = renderToStaticMarkup(
			<QuestionDock toolName="exercise" toolCallId="c1" input={exerciseInput("numeric") as never} expanded onExpand={noop} onSubmit={noop} initialAttempt={s} />,
		);
		assert.match(html, /Hint \(2 left\)/);
		assert.match(html, /Think about units/);
		assert.doesNotMatch(html, /Try the obvious operation/);
		for (let i = 0; i < 5; i++) s = exerciseAttemptReducer(s, { type: "hint", total: 3 });
		assert.equal(s.hintsUsed, 3);
		html = renderToStaticMarkup(
			<QuestionDock toolName="exercise" toolCallId="c1" input={exerciseInput("numeric") as never} expanded onExpand={noop} onSubmit={noop} initialAttempt={s} />,
		);
		assert.match(html, /Almost there/);
		assert.doesNotMatch(html, /Hint \(/);
	});

	it("requireThinking disables check until thinking", () => {
		const html = renderToStaticMarkup(
			<QuestionDock toolName="exercise" toolCallId="c1" input={exerciseInput("numeric", { requireThinking: true }) as never} expanded onExpand={noop} onSubmit={noop} initialAttempt={initialAttemptState({ value: "7" })} />,
		);
		for (const label of ["Check", "Show answer"]) {
			assert.match(html, new RegExp(`<button[^>]*disabled=\"\"[^>]*>${label}</button>`), label);
		}
		const free = renderToStaticMarkup(
			<QuestionDock toolName="exercise" toolCallId="c1" input={exerciseInput("numeric") as never} expanded onExpand={noop} onSubmit={noop} initialAttempt={initialAttemptState({ value: "7" })} />,
		);
		assert.doesNotMatch(free, /<button[^>]*disabled=\"\"[^>]*>Check<\/button>/);
		assert.match(html, /I don&#x27;t know/);
	});

	it("exercise dock shows the confidence rail and thinking field", () => {
		const html = renderToStaticMarkup(
			<QuestionDock toolName="assess" toolCallId="c1" input={exerciseInput("numeric") as never} expanded onExpand={noop} onSubmit={noop} />,
		);
		assert.match(html, /data-testid="confidence-slider"/);
		assert.match(html, /data-testid="thinking-field"/);
		assert.match(html, /data-testid="exercise-numeric"/);
	});

	it("show answer submits gaveUp", () => {
		const s = exerciseAttemptReducer(initialAttemptState({ value: "" }), { type: "giveUp" });
		assert.equal(s.gaveUp, true);
		assert.equal(s.submitting, true);
		assert.equal(exerciseAttemptReducer(initialAttemptState({}), { type: "submit" }).submitting, true);
		const input = exerciseInput("numeric") as never;
		const answer = buildExerciseAnswer(input, s.response, { attempts: s.attempts, hintsUsed: s.hintsUsed, gaveUp: s.gaveUp }, "exercise");
		assert.equal(answer.gaveUp, true);
	});
});

describe("practice dock exercise", () => {
	it("practice dock never leaks expected values", () => {
		const response = { values: { t: "99", f: "zero" } };
		const verdict = stripExpected(gradeExercise("blanks", blanksSpec, response));
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="p1"
				input={{ statement: "Fill in the facts.", format: "blanks", spec: blanksSpec } as never}
				expanded
				onExpand={noop}
				onSubmit={noop}
				initialAttempt={{ response, verdict }}
			/>,
		);
		assert.match(html, /data-testid="exercise-blanks"/);
		assert.match(html, /data-correct="false"/);
		assert.match(html, /data-correct="true"/);
		assert.doesNotMatch(noSvg(html), /100/);
		assert.match(html, />Check</);
		assert.match(html, />Hint</);
	});

	it("plain practice problems keep no Check button", () => {
		const html = renderToStaticMarkup(
			<PracticeDock problemCallId="p1" input={{ statement: "Prove it." }} expanded onExpand={noop} onSubmit={noop} />,
		);
		assert.doesNotMatch(html, />Check</);
		assert.match(html, />Hint</);
	});

	it("thinking card shows the attempt summary", () => {
		const verdict = stripExpected(gradeExercise("numeric", numericSpec, { value: "7" }));
		const html = renderToStaticMarkup(
			<ThinkingCard data={{ problemCallId: "p1", text: "my try", attempt: { format: "numeric", response: { value: "7" }, verdict } }} />,
		);
		assert.match(html, /answer wrong/);
		assert.doesNotMatch(html, /42/);
	});

	it("conclude card shows the widget in review mode with expected values", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={{ type: "tool-conclude", input: { outcome: "solved", verdict: "ok" }, reveal: "solution", problemInput: { statement: "s", format: "numeric", spec: numericSpec } } as never}
			/>,
		);
		assert.match(html, /data-testid="exercise-numeric"/);
		assert.match(html, /42/);
	});
});

describe("answered exercise card", () => {
	it("answered exercise card shows verdict", () => {
		const input = exerciseInput("blanks");
		const answer = buildExerciseAnswer(
			input as never,
			{ values: { t: "100", f: "ten" } },
			{ attempts: 2, hintsUsed: 1, gaveUp: false, confidence: 70 },
			"exercise",
		);
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
		assert.match(html, /data-testid="exercise-blanks"/);
		assert.match(html, /data-correct="false"/);
		assert.match(html, /data-correct="true"/);
		assert.match(html, /Because maths/);
		assert.match(html, /1\/2 blanks right/);
		assert.match(html, /2 attempts/);
		assert.match(html, /1 hint/);
	});

	it("a give-up is labelled", () => {
		const input = exerciseInput("numeric");
		const answer = buildExerciseAnswer(input as never, { value: "" }, { attempts: 1, hintsUsed: 0, gaveUp: true }, "assess");
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
		assert.match(html, /gave up/);
		assert.match(html, /42/);
	});
});

describe("couldn't read", () => {
	it("the notice renders only when entries were unreadable", () => {
		assert.equal(renderToStaticMarkup(<UnreadableNotice count={0} />), "");
		const html = renderToStaticMarkup(<UnreadableNotice count={2} />);
		assert.match(html, /data-testid="exercise-unreadable"/);
		assert.match(html, /Couldn(&#x27;|')t read 2 entries/);
		assert.match(html, /didn(&#x27;|')t count/);
	});
});
