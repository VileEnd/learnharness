/**
 * Safe math-expression engine (pure, browser-safe, no eval / no Function).
 *
 * Recursive-descent parser → AST → numeric evaluator, plus a deterministic
 * sampled-equivalence check used to grade "expression" answers. Grammar:
 * numbers (decimal / scientific), + - * / ^, unary minus, implicit
 * multiplication (2x, 2pi, x(y+1)), parentheses, functions
 * sqrt sin cos tan asin acos atan ln log exp abs, constants pi π e.
 * Free variables are single letters (other than `e`).
 */

import { seededRandom } from "./question-core.ts";

export type Expr =
	| { t: "num"; v: number }
	| { t: "var"; name: string }
	| { t: "neg"; a: Expr }
	| { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Expr; b: Expr }
	| { t: "call"; fn: MathFn; a: Expr };

type MathFn = "sqrt" | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "ln" | "log" | "exp" | "abs";

const FUNCS: Readonly<Record<MathFn, (x: number) => number>> = {
	sqrt: Math.sqrt,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	ln: Math.log,
	log: Math.log10,
	exp: Math.exp,
	abs: Math.abs,
};

const CONSTS: Readonly<Record<string, number>> = { pi: Math.PI, π: Math.PI, e: Math.E };

type Tok = { k: "num"; v: number } | { k: "id"; s: string } | { k: "op"; s: string };

function isFn(s: string): s is MathFn {
	return Object.hasOwn(FUNCS, s);
}

function tokenize(src: string): Tok[] | string {
	const toks: Tok[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
		if (num) {
			toks.push({ k: "num", v: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		if (/[A-Za-zπ]/.test(c)) {
			let j = i;
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
			if (j === i) j = i + 1; // lone π
			const run = src.slice(i, j);
			const whole = src[j] === "(" || isFn(run) || Object.hasOwn(CONSTS, run) || run.length === 1;
			const hasFn = Object.keys(FUNCS).some((f) => run.includes(f));
			if (whole || hasFn) {
				toks.push({ k: "id", s: run });
			} else {
				// adjacent single-letter variables / pi: `xy`, `2xy`, `xpi` → implicit multiplication
				for (let m = 0; m < run.length; ) {
					const piece = run.startsWith("pi", m) ? "pi" : run[m]!;
					toks.push({ k: "id", s: piece });
					m += piece.length;
				}
			}
			i = j;
			continue;
		}
		if ("+-*/^()".includes(c)) {
			toks.push({ k: "op", s: c });
			i++;
			continue;
		}
		return `unexpected character "${c}"`;
	}
	return toks;
}

class ParseError extends Error {}

class Parser {
	private i = 0;
	constructor(private readonly toks: Tok[]) {}

	private peek(): Tok | undefined {
		return this.toks[this.i];
	}
	private isOp(s: string): boolean {
		const t = this.peek();
		return t?.k === "op" && t.s === s;
	}

	parseAll(): Expr {
		if (this.toks.length === 0) throw new ParseError("empty expression");
		const e = this.additive();
		if (this.i < this.toks.length) throw new ParseError("unexpected token");
		return e;
	}

	private additive(): Expr {
		let a = this.term();
		while (this.isOp("+") || this.isOp("-")) {
			const op = (this.toks[this.i++] as { s: "+" | "-" }).s;
			a = { t: "bin", op, a, b: this.term() };
		}
		return a;
	}

	private startsFactor(): boolean {
		const t = this.peek();
		return t !== undefined && (t.k === "num" || t.k === "id" || (t.k === "op" && t.s === "("));
	}

	/** term := unary (('*' | '/') unary | implicit-mult unary)* */
	private term(): Expr {
		let a = this.unary();
		for (;;) {
			if (this.isOp("*") || this.isOp("/")) {
				const op = (this.toks[this.i++] as { s: "*" | "/" }).s;
				a = { t: "bin", op, a, b: this.unary() };
			} else if (this.startsFactor()) {
				a = { t: "bin", op: "*", a, b: this.power() };
			} else return a;
		}
	}

	private unary(): Expr {
		if (this.isOp("-")) {
			this.i++;
			return { t: "neg", a: this.unary() };
		}
		if (this.isOp("+")) {
			this.i++;
			return this.unary();
		}
		return this.power();
	}

	/** power := primary ('^' unary)?  (right-assoc; exponent may be negated) */
	private power(): Expr {
		const base = this.primary();
		if (this.isOp("^")) {
			this.i++;
			return { t: "bin", op: "^", a: base, b: this.unary() };
		}
		return base;
	}

	private primary(): Expr {
		const t = this.toks[this.i++];
		if (!t) throw new ParseError("unexpected end");
		if (t.k === "num") return { t: "num", v: t.v };
		if (t.k === "op") {
			if (t.s !== "(") throw new ParseError(`unexpected "${t.s}"`);
			const e = this.additive();
			if (!this.isOp(")")) throw new ParseError('missing ")"');
			this.i++;
			return e;
		}
		const s = t.s;
		if (isFn(s)) {
			if (!this.isOp("(")) throw new ParseError(`${s} needs parentheses`);
			this.i++;
			const a = this.additive();
			if (!this.isOp(")")) throw new ParseError('missing ")"');
			this.i++;
			return { t: "call", fn: s, a };
		}
		if (Object.hasOwn(CONSTS, s)) return { t: "num", v: CONSTS[s]! };
		if (/^[A-Za-z]$/.test(s)) return { t: "var", name: s };
		throw new ParseError(`unknown identifier "${s}"`);
	}
}

export function parseExpr(src: string): { ok: true; expr: Expr } | { ok: false; error: string } {
	const toks = tokenize(src);
	if (typeof toks === "string") return { ok: false, error: toks };
	try {
		return { ok: true, expr: new Parser(toks).parseAll() };
	} catch (e) {
		if (e instanceof ParseError) return { ok: false, error: e.message };
		throw e;
	}
}

/** Evaluate; NaN on a domain error or unbound variable. Never throws. */
export function evalExpr(expr: Expr, vars: Readonly<Record<string, number>>): number {
	switch (expr.t) {
		case "num":
			return expr.v;
		case "var":
			return Object.hasOwn(vars, expr.name) ? (vars[expr.name] as number) : Number.NaN;
		case "neg":
			return -evalExpr(expr.a, vars);
		case "call":
			return FUNCS[expr.fn](evalExpr(expr.a, vars));
		case "bin": {
			const a = evalExpr(expr.a, vars);
			const b = evalExpr(expr.b, vars);
			switch (expr.op) {
				case "+":
					return a + b;
				case "-":
					return a - b;
				case "*":
					return a * b;
				case "/":
					return a / b;
				case "^":
					return a ** b;
			}
		}
	}
}

/** Numeric value of a typed answer ("1/3", "−5", "0,5", "1e-3", "2pi"), or null. */
export function parseNumberLike(src: string): number | null {
	let s = src.trim().replace(/[−–—]/g, "-");
	if (!s) return null;
	if (!s.includes(".") && /^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
	const r = parseExpr(s);
	if (!r.ok) return null;
	const v = evalExpr(r.expr, {});
	return Number.isFinite(v) ? v : null;
}

const SAMPLE_POINTS = 12;
const MIN_COMPARED = 4;

/** Sampled equivalence over deterministic points in [-5, 5]; see Task 1 brief. */
export function exprEquivalent(
	a: string,
	b: string,
	variables: readonly string[],
	opts?: { rel?: number; abs?: number },
): boolean {
	const pa = parseExpr(a);
	const pb = parseExpr(b);
	if (!pa.ok || !pb.ok) return false;
	const rel = opts?.rel ?? 1e-6;
	const abs = opts?.abs ?? 1e-9;
	const rands = variables.map((v) => seededRandom(`expr:${v}`));
	let compared = 0;
	for (let p = 0; p < SAMPLE_POINTS; p++) {
		const vars: Record<string, number> = {};
		variables.forEach((v, idx) => {
			let x = 0;
			do x = rands[idx]!() * 10 - 5;
			while (Math.abs(x) < 0.05);
			vars[v] = x;
		});
		const x = evalExpr(pa.expr, vars);
		const y = evalExpr(pb.expr, vars);
		const fx = Number.isFinite(x);
		const fy = Number.isFinite(y);
		if (!fx && !fy) continue;
		if (fx !== fy) return false;
		if (Math.abs(x - y) > abs + rel * Math.max(Math.abs(x), Math.abs(y))) return false;
		compared++;
	}
	return compared >= MIN_COMPARED;
}
