/**
 * The library-rooted file tools (OKF library PR 1): read/ls/find/grep are
 * confined to the library root. Escapes (absolute, `..`, symlinks) are
 * refused; a missing root answers with the "being built" copy and is never
 * created; no agent registry carries the retired `pdf` job.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-libfs-data-"));
process.env.LH_DATA_DIR = dataDir;

const ESCAPE = "Paths are relative to the library root (start with index.md); absolute paths and '..' are not allowed.";
const MISSING = "The library is empty right now (it is being built). Try search_documents.";

let root: string;
const { readToolFor } = await import("../src/agent/tools/read.ts");
const { lsToolFor } = await import("../src/agent/tools/ls.ts");
const { findToolFor } = await import("../src/agent/tools/find.ts");
const { grepToolFor } = await import("../src/agent/tools/grep.ts");

async function text(tool: AgentTool<any>, params: unknown): Promise<string> {
	const result = await tool.execute!("c", params);
	return (result.content[0] as { text: string }).text;
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-libfs-root-"));
	fs.mkdirSync(path.join(root, "concepts"));
	fs.writeFileSync(path.join(root, "index.md"), "# Library\nneedle in the index\n");
	fs.writeFileSync(path.join(root, "concepts", "a.md"), "Concept A\nneedle here too\n");
	fs.symlinkSync("/etc/hostname", path.join(root, "concepts", "evil.md"));
});

describe("library-fs", () => {
	it("read resolves relative paths inside the root", async () => {
		assert.equal(await text(readToolFor(root), { path: "concepts/a.md" }), "Concept A\nneedle here too\n");
	});

	it("library-fs refuses escapes", async () => {
		const read = readToolFor(root);
		for (const p of ["../x", "/data/auth.json", "concepts/../../x", "concepts/evil.md"]) {
			await assert.rejects(() => read.execute!("c", { path: p }), (e: Error) => e.message === ESCAPE, p);
		}
		await assert.rejects(() => lsToolFor(root).execute!("c", { path: ".." }), (e: Error) => e.message === ESCAPE);
		await assert.rejects(
			() => findToolFor(root).execute!("c", { pattern: "*", path: "/etc" }),
			(e: Error) => e.message === ESCAPE,
		);
		await assert.rejects(
			() => grepToolFor(root).execute!("c", { pattern: "x", path: "concepts/evil.md" }),
			(e: Error) => e.message === ESCAPE,
		);
	});

	it("a non-existent target inside the root is reported as not found", async () => {
		await assert.rejects(() => readToolFor(root).execute!("c", { path: "concepts/nope.md" }), /File not found/);
	});

	it("find and grep never list outside the root", async () => {
		const found = await text(findToolFor(root), { pattern: "**/*" });
		assert.deepEqual(found.split("\n").sort(), ["concepts/a.md", "index.md"]);
		const grepped = await text(grepToolFor(root), { pattern: "needle" });
		assert.ok(!grepped.includes("/etc") && !grepped.includes(root), "no absolute paths");
		assert.match(grepped, /index\.md:2: needle in the index/);
		assert.match(grepped, /concepts\/a\.md:2: needle here too/);
		assert.ok(!grepped.includes("evil"), "symlinks are not followed");
	});

	it("missing root answers with the empty-library copy", async () => {
		const missing = path.join(os.tmpdir(), `lh-libfs-missing-${process.pid}`);
		const calls: Array<[AgentTool<any>, object]> = [
			[readToolFor(missing), { path: "index.md" }],
			[lsToolFor(missing), {}],
			[findToolFor(missing), { pattern: "*" }],
			[grepToolFor(missing), { pattern: "x" }],
		];
		for (const [tool, params] of calls) {
			await assert.rejects(() => tool.execute!("c", params), (e: Error) => e.message === MISSING);
		}
		assert.equal(fs.existsSync(missing), false, "the root is never created");
	});

	it("no agent registry carries pdf", async () => {
		const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
		const { practiceTools } = await import("../src/agent/tools/practice.ts");
		const { chatStore } = await import("../src/store/chats.ts");
		const { jobStore } = await import("../src/store/jobs.ts");
		const chatId = chatStore.createChat("library-fs").id;
		const base = { chatId, chatStore, jobStore, spawn: () => {}, libraryRoot: root };
		const registries = [
			createTeacherTools(base),
			createProberTools({ ...base, deliver: () => {} }),
			practiceTools({ chatId, chatStore, libraryRoot: root, jobs: { chatId, jobStore, spawn: () => {} } }),
		];
		for (const r of registries) {
			assert.ok(!Object.keys(r).includes("pdf"));
			assert.ok(Object.keys(r).includes("read"));
		}
	});
});
