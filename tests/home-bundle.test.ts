/**
 * The home route's first load must not carry the markdown renderer.
 *
 * components/ai-elements/message.tsx pulls in Streamdown, its code and math
 * plugins, md-blocks, the session overlay and the mermaid loader: about 0.7 MB
 * of first-load JavaScript that the home page does not need (release 0.55.0
 * was a bundle diet for this page). Home surfaces that show model text after a
 * click render it through components/statement-text.tsx, which loads the
 * renderer on demand. This walks the STATIC imports from components/home.tsx
 * (relative and `@/` specifiers; `import()` is not followed, that is the
 * point) and fails if message.tsx becomes reachable, with the chain that
 * reaches it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const RENDERER = path.join(ROOT, "components/ai-elements/message.tsx");

function resolveSpecifier(from: string, specifier: string): string | null {
	const base = specifier.startsWith("@/") ? path.join(ROOT, specifier.slice(2))
		: specifier.startsWith(".") ? path.resolve(path.dirname(from), specifier) : null;
	if (!base) return null; // a package: not our code
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/** Static import/export-from specifiers. `import type` is erased; `import()`
 *  is a CallExpression and is never visited here. */
function staticImports(file: string): string[] {
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const found: string[] = [];
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)) found.push(statement.moduleSpecifier.text);
		if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) found.push(statement.moduleSpecifier.text);
	}
	return found;
}

/** The first static chain from `entry` to `target`, or null. */
function chainTo(entry: string, target: string): string[] | null {
	const parent = new Map<string, string>([[entry, ""]]);
	const queue = [entry];
	while (queue.length) {
		const file = queue.shift()!;
		if (file === target) {
			const chain: string[] = [];
			for (let at: string = file; at; at = parent.get(at)!) chain.unshift(path.relative(ROOT, at));
			return chain;
		}
		for (const specifier of staticImports(file)) {
			const next = resolveSpecifier(file, specifier);
			if (next && !parent.has(next)) { parent.set(next, file); queue.push(next); }
		}
	}
	return null;
}

describe("the home route's static imports", () => {
	it("never reach the markdown renderer (components/ai-elements/message.tsx)", () => {
		const chain = chainTo(path.join(ROOT, "components/home.tsx"), RENDERER);
		assert.equal(chain, null, `components/home.tsx statically reaches the renderer: ${chain?.join(" -> ")}`);
	});

	it("the walker finds a static chain when there is one (the guard is not vacuous)", () => {
		assert.ok(chainTo(path.join(ROOT, "components/work-cards.tsx"), RENDERER), "work-cards imports ToolContentResponse directly");
		assert.ok(chainTo(path.join(ROOT, "components/practice-dock.tsx"), RENDERER));
	});
});
