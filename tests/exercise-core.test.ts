/** Unit tests — exercise-core (pure, no server, no LLM). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { exerciseSpecProblems, gradeExercise, stripExpected } from "../src/core/exercise-core.ts";

test("numeric honours tolerance", () => {
	const spec = { answer: "1/3", mode: "number", tolerance: { abs: 0.001 } };
	assert.equal(gradeExercise("numeric", spec, { value: "0.333" }).outcome, "correct");
	assert.equal(gradeExercise("numeric", spec, { value: "0.33" }).outcome, "wrong");
	assert.equal(gradeExercise("numeric", { answer: "9.81", mode: "number", unit: "m/s^2", tolerance: { rel: 0.01 } }, { value: "9.8 m/s^2" }).outcome, "correct");
});
test("numeric expression mode", () => {
	const spec = { answer: "2x", mode: "expression", variables: ["x"] };
	assert.equal(gradeExercise("numeric", spec, { value: "x + x" }).outcome, "correct");
});
test("blanks per blank, case and mode", () => {
	const spec = { text: "{{f}} = m{{a}}", blanks: [{ id: "f", accept: ["F"], caseSensitive: true }, { id: "a", accept: ["a"] }] };
	const v = gradeExercise("blanks", spec, { values: { f: "f", a: "A" } });
	assert.deepEqual([v.earned, v.total], [1, 2]);
});
test("table grades editable cells only, bit mode strict", () => {
	const spec = { columns: ["A", "B", "A∧B"], rows: [{ cells: [{ given: "0" }, { given: "1" }, { id: "r1", accept: ["0"], mode: "bit" }] }, { cells: [{ given: "1" }, { given: "1" }, { id: "r2", accept: ["1"], mode: "bit" }] }] };
	const v = gradeExercise("table", spec, { values: { r1: "0", r2: "yes" } });
	assert.deepEqual([v.outcome, v.earned, v.total], ["partly", 1, 2]);
});
test("multipart weights and namespacing", () => {
	const spec = { parts: [
		{ id: "a", label: "(a)", format: "numeric", spec: { answer: "2", mode: "number" }, weight: 2 },
		{ id: "b", label: "(b)", format: "blanks", spec: { text: "{{x}}", blanks: [{ id: "x", accept: ["y"] }] } },
	] };
	const v = gradeExercise("multipart", spec, { parts: { a: { value: "2" }, b: { values: { x: "z" } } } });
	assert.deepEqual([v.earned, v.total], [2, 3]);
	assert.ok(v.items.some((i) => i.id === "b.x" && !i.correct));
});
test("schema-valid iff gradeable", () => {
	assert.ok(exerciseSpecProblems("numeric", { answer: "abc(", mode: "number" }).length > 0);
	assert.ok(exerciseSpecProblems("table", { columns: ["A"], rows: [{ cells: [{ given: "1" }] }] }).length > 0); // no editable cell
	assert.ok(exerciseSpecProblems("multipart", { parts: [{ id: "a", label: "a", format: "multipart", spec: {} }] }).length > 0); // nesting
	assert.ok(exerciseSpecProblems("matching", {}).length > 0); // not implemented in this build
	assert.deepEqual(exerciseSpecProblems("numeric", { answer: "2", mode: "number" }), []);
});
test("stripExpected removes answers", () => {
	const v = gradeExercise("blanks", { text: "{{x}}", blanks: [{ id: "x", accept: ["y"] }] }, { values: { x: "z" } });
	assert.equal(stripExpected(v).items[0]!.expected, undefined);
});
test("malformed response never throws", () => {
	assert.equal(gradeExercise("table", { columns: ["A"], rows: [{ cells: [{ id: "c", accept: ["1"] }] }] }, null).outcome, "wrong");
});

test("expression answers must declare their variables", async () => {
	const { exerciseSpecProblems, gradeExercise } = await import("../src/core/exercise-core.ts");
	assert.ok(exerciseSpecProblems("numeric", { answer: "2x", mode: "expression" }).length > 0);
	assert.deepEqual(exerciseSpecProblems("numeric", { answer: "2x", mode: "expression", variables: ["x"] }), []);
	const blanks = (b: object) => ({ text: "{{a}}", blanks: [{ id: "a", accept: ["2x"], mode: "expression", ...b }] });
	assert.ok(exerciseSpecProblems("blanks", blanks({})).length > 0);
	assert.ok(exerciseSpecProblems("blanks", blanks({ variables: "x" })).length > 0);
	assert.deepEqual(exerciseSpecProblems("blanks", blanks({ variables: ["x"] })), []);
	assert.equal(gradeExercise("numeric", { answer: "2x", mode: "expression", variables: ["x"] }, { value: "x+x" }).outcome, "correct");
});
