import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * The core barrel is shipped to the browser, so no module reachable from it
 * through VALUE imports may pull in a Node builtin (the bundler would ship a
 * polyfill to every page). Type-only imports/exports are erased and ignored.
 */
const ENTRY = resolve("src/core/index.ts");
const BUILTINS = /^(node:.*|crypto|fs|path|os|stream|buffer|child_process|util|events)$/;
// `import x from "m"`, `import "m"`, `export {…} from "m"`, `export * from "m"`
const FROM = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;"'`]*?\bfrom\s*)?["']([^"']+)["']/g;

function specifiers(source: string): string[] {
	const out: string[] = [];
	for (const m of source.matchAll(FROM)) {
		const [, kind, isType, fromPart, spec] = m;
		if (isType) continue;
		if (kind === "export" && !fromPart) continue;
		out.push(spec as string);
	}
	return out;
}

describe("core barrel", () => {
	it("reaches no Node builtin through value imports", () => {
		const seen = new Set<string>();
		const offenders: string[] = [];
		const queue = [ENTRY];
		while (queue.length) {
			const file = queue.pop() as string;
			if (seen.has(file)) continue;
			seen.add(file);
			for (const spec of specifiers(readFileSync(file, "utf8"))) {
				if (BUILTINS.test(spec)) offenders.push(`${file} -> ${spec}`);
				else if (spec.startsWith(".")) {
					const target = resolve(dirname(file), spec);
					if (existsSync(target)) queue.push(target);
				}
			}
		}
		assert.deepEqual(offenders, []);
	});
});
