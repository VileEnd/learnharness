/**
 * Interactive exercise contract + deterministic graders (generative formats).
 * Pure and browser-safe: imports only core. The browser grades; the verdict is the tool output.
 */

import { exprEquivalent, parseExpr, parseNumberLike, type Expr } from "./math-expr.ts";

export const INTERACTIVE_FORMATS = [
	"numeric", "blanks", "table", "multipart", "ordering", "matching", "spot-error",
	"fields", "sequence", "plot", "label", "graph", "code",
] as const;
export type InteractiveFormat = (typeof INTERACTIVE_FORMATS)[number];

export const PR1_FORMATS = ["numeric", "blanks", "table", "multipart"] as const;
/** Formats with a grader in this build. */
export const IMPLEMENTED_FORMATS: readonly InteractiveFormat[] = PR1_FORMATS;

export type CellMode = "text" | "number" | "expression";

export interface NumericSpec {
	answer: string;
	mode: "number" | "expression";
	variables?: string[];
	tolerance?: { abs?: number; rel?: number };
	unit?: string;
}
export interface BlankSpec {
	id: string;
	accept: string[];
	mode?: CellMode;
	caseSensitive?: boolean;
	variables?: string[];
}
export interface BlanksSpec {
	text: string;
	blanks: BlankSpec[];
}
export type TableCell = { given: string } | { id: string; accept: string[]; mode?: CellMode | "bit"; variables?: string[] };
export interface TableSpec {
	columns: string[];
	rows: { cells: TableCell[] }[];
}
export interface MultipartSpec {
	parts: { id: string; label: string; format: "numeric" | "blanks" | "table"; spec: unknown; weight?: number }[];
}

export type ItemVerdict = { id: string; correct: boolean; expected?: string; given?: string };
export type ExerciseVerdict = {
	outcome: "correct" | "partly" | "wrong";
	earned: number;
	total: number;
	items: ItemVerdict[];
	summary: string;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const round2 = (n: number) => Math.round(n * 100) / 100;
const MODES = ["text", "number", "expression"];

function identifiers(e: Expr, out: Set<string> = new Set()): Set<string> {
	if (e.t === "var") out.add(e.name);
	else if (e.t === "neg" || e.t === "call") identifiers(e.a, out);
	else if (e.t === "bin") { identifiers(e.a, out); identifiers(e.b, out); }
	return out;
}

function checkAnswer(src: string, mode: string, variables: readonly string[] = []): string | null {
	if (mode === "number") return parseNumberLike(src) === null ? `"${src}" is not a number` : null;
	if (mode === "expression") {
		const r = parseExpr(src);
		if (!r.ok) return `"${src}" is not a valid expression: ${r.error}`;
		const unknown = [...identifiers(r.expr)].filter((n) => !variables.includes(n));
		return unknown.length ? `"${src}" uses ${unknown.join(", ")} not listed in variables` : null;
	}
	return null;
}

function numericProblems(spec: unknown): string[] {
	if (!isRec(spec)) return ["spec must be an object"];
	const p: string[] = [];
	if (!isStr(spec.answer) || !spec.answer.trim()) return ["answer must be a non-empty string"];
	if (spec.mode !== "number" && spec.mode !== "expression") p.push('mode must be "number" or "expression"');
	else {
		const e = checkAnswer(spec.answer, spec.mode, isStrArr(spec.variables) ? spec.variables : []);
		if (e) p.push(`answer ${e}`);
	}
	if (spec.variables !== undefined && !isStrArr(spec.variables)) p.push("variables must be a string array");
	if (spec.unit !== undefined && !isStr(spec.unit)) p.push("unit must be a string");
	if (spec.tolerance !== undefined) {
		const t = spec.tolerance;
		if (!isRec(t) || [t.abs, t.rel].some((x) => x !== undefined && (typeof x !== "number" || !(x >= 0)))) p.push("tolerance must be {abs?, rel?} of non-negative numbers");
	}
	return p;
}

function acceptProblems(where: string, c: Rec, modes: string[]): string[] {
	const p: string[] = [];
	if (!isStr(c.id) || !c.id) p.push(`${where}: id must be a non-empty string`);
	if (!isStrArr(c.accept) || c.accept.length === 0) return [...p, `${where}: accept must be a non-empty string array`];
	const mode = c.mode === undefined ? "text" : c.mode;
	if (!isStr(mode) || !modes.includes(mode)) return [...p, `${where}: mode must be one of ${modes.join(", ")}`];
	if (c.variables !== undefined && !isStrArr(c.variables)) p.push(`${where}: variables must be a string array`);
	if (mode === "number" || mode === "expression") {
		const vars = isStrArr(c.variables) ? c.variables : [];
		for (const a of c.accept) {
			const e = checkAnswer(a, mode, vars);
			if (e) p.push(`${where}: accept ${e}`);
		}
	}
	return p;
}

function blanksProblems(spec: unknown): string[] {
	if (!isRec(spec)) return ["spec must be an object"];
	if (!isStr(spec.text)) return ["text must be a string"];
	if (!Array.isArray(spec.blanks) || spec.blanks.length === 0) return ["blanks must be a non-empty array"];
	const p: string[] = [];
	const ids = new Set<string>();
	for (const b of spec.blanks) {
		if (!isRec(b)) { p.push("each blank must be an object"); continue; }
		p.push(...acceptProblems(`blank ${String(b.id)}`, b, MODES));
		if (isStr(b.id)) {
			if (ids.has(b.id)) p.push(`duplicate blank id "${b.id}"`);
			ids.add(b.id);
		}
	}
	const used = [...spec.text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]!.trim());
	for (const id of ids) if (!used.includes(id)) p.push(`blank "${id}" has no {{${id}}} placeholder in text`);
	for (const u of used) if (!ids.has(u)) p.push(`placeholder {{${u}}} has no blank`);
	return p;
}

function tableProblems(spec: unknown): string[] {
	if (!isRec(spec)) return ["spec must be an object"];
	if (!isStrArr(spec.columns) || spec.columns.length === 0) return ["columns must be a non-empty string array"];
	if (!Array.isArray(spec.rows) || spec.rows.length === 0) return ["rows must be a non-empty array"];
	const p: string[] = [];
	const ids = new Set<string>();
	let editable = 0;
	const ncols = spec.columns.length;
	spec.rows.forEach((row, ri) => {
		if (!isRec(row) || !Array.isArray(row.cells)) { p.push(`row ${ri + 1}: cells must be an array`); return; }
		if (row.cells.length !== ncols) p.push(`row ${ri + 1}: needs ${ncols} cells`);
		for (const c of row.cells) {
			if (!isRec(c)) { p.push(`row ${ri + 1}: cell must be an object`); continue; }
			if ("given" in c) {
				if (!isStr(c.given)) p.push(`row ${ri + 1}: given must be a string`);
				continue;
			}
			editable++;
			p.push(...acceptProblems(`cell ${String(c.id)}`, c, [...MODES, "bit"]));
			if (isStr(c.id)) {
				if (ids.has(c.id)) p.push(`duplicate cell id "${c.id}"`);
				ids.add(c.id);
			}
		}
	});
	if (editable === 0) p.push("table needs at least one editable cell");
	return p;
}

const PART_FORMATS = ["numeric", "blanks", "table"];

function multipartProblems(spec: unknown): string[] {
	if (!isRec(spec) || !Array.isArray(spec.parts)) return ["parts must be an array"];
	if (spec.parts.length < 2 || spec.parts.length > 6) return ["multipart needs 2-6 parts"];
	const p: string[] = [];
	const ids = new Set<string>();
	for (const part of spec.parts) {
		if (!isRec(part)) { p.push("each part must be an object"); continue; }
		const id = String(part.id);
		if (!isStr(part.id) || !part.id || part.id.includes(".")) p.push(`part id "${id}" must be non-empty without "."`);
		if (ids.has(id)) p.push(`duplicate part id "${id}"`);
		ids.add(id);
		if (!isStr(part.label)) p.push(`part ${id}: label must be a string`);
		if (part.weight !== undefined && (typeof part.weight !== "number" || !(part.weight > 0))) p.push(`part ${id}: weight must be positive`);
		if (!isStr(part.format) || !PART_FORMATS.includes(part.format)) { p.push(`part ${id}: format must be numeric, blanks or table (no nesting)`); continue; }
		p.push(...exerciseSpecProblems(part.format, part.spec).map((x) => `part ${id}: ${x}`));
	}
	return p;
}

/** Empty means gradeable. */
export function exerciseSpecProblems(format: string, spec: unknown): string[] {
	if (!(IMPLEMENTED_FORMATS as readonly string[]).includes(format)) return [`format "${format}" is not available in this build`];
	switch (format) {
		case "numeric": return numericProblems(spec);
		case "blanks": return blanksProblems(spec);
		case "table": return tableProblems(spec);
		default: return multipartProblems(spec);
	}
}

// ---- grading ----

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

function matchesAny(given: string, accept: string[], mode: string, opts: { caseSensitive?: boolean; variables?: string[] }): boolean {
	const g = norm(given);
	if (!g) return false;
	if (mode === "bit") return accept.some((a) => a === g);
	if (mode === "number") {
		const gv = parseNumberLike(g);
		if (gv === null) return false;
		return accept.some((a) => {
			const av = parseNumberLike(a);
			return av !== null && Math.abs(gv - av) <= 1e-9 + 1e-9 * Math.abs(av);
		});
	}
	if (mode === "expression") return accept.some((a) => exprEquivalent(g, a, opts.variables ?? []));
	return accept.some((a) => (opts.caseSensitive ? norm(a) === g : norm(a).toLowerCase() === g.toLowerCase()));
}

function verdict(items: ItemVerdict[], earned: number, total: number, noun: string): ExerciseVerdict {
	earned = round2(earned);
	total = round2(total);
	const outcome = total > 0 && earned >= total ? "correct" : earned > 0 ? "partly" : "wrong";
	const right = items.filter((i) => i.correct).length;
	return { outcome, earned, total, items, summary: items.length === 1 && noun === "answer" ? (right ? "answer right" : "answer wrong") : `${right}/${items.length} ${noun} right` };
}

const valuesOf = (response: unknown): Rec => (isRec(response) && isRec(response.values) ? response.values : {});
const str = (v: unknown) => (isStr(v) ? v : "");

function gradeNumeric(spec: NumericSpec, response: unknown): ExerciseVerdict {
	let given = isRec(response) ? str(response.value).trim() : "";
	if (spec.unit) {
		const u = spec.unit.trim();
		if (u && given.toLowerCase().endsWith(u.toLowerCase())) given = given.slice(0, given.length - u.length).trim();
	}
	let correct = false;
	if (given) {
		if (spec.mode === "expression") correct = exprEquivalent(given, spec.answer, spec.variables ?? []);
		else {
			const gv = parseNumberLike(given);
			const av = parseNumberLike(spec.answer);
			if (gv !== null && av !== null) {
				const abs = spec.tolerance?.abs ?? 0;
				const rel = spec.tolerance?.rel ?? 0;
				correct = Math.abs(gv - av) <= abs + rel * Math.abs(av) + 1e-9 * (1 + Math.abs(av));
			}
		}
	}
	const expected = spec.unit ? `${spec.answer} ${spec.unit}` : spec.answer;
	return verdict([{ id: "answer", correct, expected, given: given || undefined }], correct ? 1 : 0, 1, "answer");
}

function gradeBlanks(spec: BlanksSpec, response: unknown): ExerciseVerdict {
	const vals = valuesOf(response);
	const items = spec.blanks.map((b): ItemVerdict => {
		const given = str(vals[b.id]);
		return { id: b.id, correct: matchesAny(given, b.accept, b.mode ?? "text", b), expected: b.accept[0], given: given || undefined };
	});
	return verdict(items, items.filter((i) => i.correct).length, items.length, "blanks");
}

function gradeTable(spec: TableSpec, response: unknown): ExerciseVerdict {
	const vals = valuesOf(response);
	const items: ItemVerdict[] = [];
	for (const row of spec.rows) {
		for (const c of row.cells) {
			if (!("id" in c)) continue;
			const given = str(vals[c.id]);
			items.push({ id: c.id, correct: matchesAny(given, c.accept, c.mode ?? "text", { variables: c.variables }), expected: c.accept[0], given: given || undefined });
		}
	}
	return verdict(items, items.filter((i) => i.correct).length, items.length, "cells");
}

function gradeMultipart(spec: MultipartSpec, response: unknown): ExerciseVerdict {
	const parts = isRec(response) && isRec(response.parts) ? response.parts : {};
	const items: ItemVerdict[] = [];
	let earned = 0;
	let total = 0;
	let partsRight = 0;
	for (const part of spec.parts) {
		const w = part.weight ?? 1;
		const v = gradeExercise(part.format, part.spec, parts[part.id]);
		for (const it of v.items) items.push({ ...it, id: `${part.id}.${it.id}` });
		total += w;
		if (v.total > 0) earned += w * (v.earned / v.total);
		if (v.outcome === "correct") partsRight++;
	}
	const r = verdict(items, earned, total, "items");
	r.summary = `${partsRight}/${spec.parts.length} parts right`;
	return r;
}

const WRONG: ExerciseVerdict = { outcome: "wrong", earned: 0, total: 0, items: [], summary: "not gradeable" };

/** Never throws: a malformed spec or response grades wrong. */
export function gradeExercise(format: InteractiveFormat, spec: unknown, response: unknown): ExerciseVerdict {
	try {
		if (exerciseSpecProblems(format, spec).length > 0) return WRONG;
		switch (format) {
			case "numeric": return gradeNumeric(spec as NumericSpec, response);
			case "blanks": return gradeBlanks(spec as BlanksSpec, response);
			case "table": return gradeTable(spec as TableSpec, response);
			case "multipart": return gradeMultipart(spec as MultipartSpec, response);
			default: return WRONG;
		}
	} catch {
		return WRONG;
	}
}

/** Marks-only view: removes the expected answers. */
export function stripExpected(v: ExerciseVerdict): ExerciseVerdict {
	return { ...v, items: v.items.map(({ expected: _e, ...rest }) => rest) };
}
