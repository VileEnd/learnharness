/** Unit tests — math-expr (pure, no server, no LLM). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { evalExpr, exprEquivalent, parseExpr, parseNumberLike } from "../src/core/math-expr.ts";

test("parseNumberLike normalises", () => {
	assert.equal(parseNumberLike("1/3"), 1 / 3);
	assert.equal(parseNumberLike("−5"), -5);
	assert.equal(parseNumberLike("0,5"), 0.5);
	assert.equal(parseNumberLike("1e-3"), 0.001);
	assert.ok(Math.abs(parseNumberLike("2pi")! - 2 * Math.PI) < 1e-12);
	assert.equal(parseNumberLike("abc"), null);
	assert.equal(parseNumberLike("x"), null);
	assert.equal(parseNumberLike(""), null);
});

test("evalExpr implicit multiplication and functions", () => {
	const r = parseExpr("2x^2 + sin(pi/2)");
	assert.ok(r.ok);
	assert.equal(evalExpr(r.expr, { x: 3 }), 19);
});

test("evalExpr precedence and domain errors", () => {
	const ev = (s: string, v: Record<string, number> = {}) => {
		const r = parseExpr(s);
		assert.ok(r.ok, s);
		return evalExpr(r.expr, v);
	};
	assert.equal(ev("-x^2", { x: 3 }), -9);
	assert.equal(ev("2^3^2"), 512);
	assert.equal(ev("x(y+1)", { x: 2, y: 3 }), 8);
	assert.equal(ev("2π"), 2 * Math.PI);
	assert.ok(Number.isNaN(ev("sqrt(-1)")));
	assert.ok(Number.isNaN(ev("ln(-1)")));
	assert.ok(Number.isNaN(ev("z"))); // unbound variable: NaN, never throws
});

test("exprEquivalent skips shared poles", () => {
	assert.equal(exprEquivalent("1/x", "x^-1", ["x"]), true);
	assert.equal(exprEquivalent("(x^2-1)/(x-1)", "x+1", ["x"]), true);
	assert.equal(exprEquivalent("sqrt(x^2)", "x", ["x"]), false);
	assert.equal(exprEquivalent("1/0", "1/0", []), false); // < 4 valid points
	assert.equal(exprEquivalent("x+y", "y+x", ["x", "y"]), true);
});

test("parseExpr rejects unknown identifiers", () => {
	assert.equal(parseExpr("constructor(1)").ok, false);
	assert.equal(parseExpr("y + 1").ok, true); // free variables are allowed; equivalence fixes them
	assert.equal(parseExpr("2 +").ok, false);
	assert.equal(parseExpr("(1").ok, false);
	assert.equal(parseExpr("1 $ 2").ok, false);
});

test("adjacent single-letter variables multiply implicitly", () => {
	assert.equal(parseExpr("xy").ok, true);
	assert.equal(parseExpr("2xy").ok, true);
	assert.equal(parseExpr("xpi").ok, true);
	assert.equal(exprEquivalent("2xy", "2yx", ["x", "y"]), true);
	assert.equal(exprEquivalent("2xy", "3xy", ["x", "y"]), false);
	assert.equal(exprEquivalent("xpi", "pi*x", ["x"]), true);
	assert.equal(parseExpr("xsinx").ok, false); // a function inside a letter run stays unreadable
});

test("common typed notation grades like its ASCII form", () => {
	assert.equal(exprEquivalent("x²", "x^2", ["x"]), true);
	assert.equal(exprEquivalent("x⁻¹", "1/x", ["x"]), true);
	assert.equal(parseNumberLike("3×4"), 12);
	assert.equal(parseNumberLike("12÷4"), 3);
	assert.equal(exprEquivalent("2·x", "2x", ["x"]), true);
	assert.equal(exprEquivalent("2⋅x − 1", "2x-1", ["x"]), true);
	assert.equal(exprEquivalent("sinx", "sin(x)", ["x"]), true);
	assert.equal(exprEquivalent("sin 2x", "sin(2x)", ["x"]), true);
	assert.equal(exprEquivalent("sin x cos x", "sin(x)*cos(x)", ["x"]), true);
	assert.equal(exprEquivalent("√x", "sqrt(x)", ["x"]), true);
	assert.equal(parseNumberLike("2√9"), 6);
	assert.equal(parseExpr("sinh(x)").ok, false); // not a function we know, never sin(h·x)
});

test("thousands separators and number juxtaposition", () => {
	assert.equal(parseNumberLike("1,000,000"), 1_000_000);
	assert.equal(parseNumberLike("1,000.5"), 1000.5);
	assert.equal(parseNumberLike("1,000"), null); // German 1.0 or English 1000: refused, not guessed
	assert.equal(parseNumberLike("0,125"), 0.125);
	assert.equal(parseNumberLike("1 000"), null);
	assert.equal(parseNumberLike("2 3"), null);
	assert.equal(parseNumberLike("2^3 4"), null);
	assert.equal(parseNumberLike("2 pi"), 2 * Math.PI);
});
