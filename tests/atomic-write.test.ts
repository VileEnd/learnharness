/**
 * Crash-safe store writes: src/store/atomic-write.ts (ported from upstream
 * 5a7ec1b, Linux only) plus the store writers that use it. Runs under an
 * isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-atomic-write-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth", "auth.json");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { removeLeftoverTemps, writeFileAtomicSync } = await import("../src/store/atomic-write.ts");
const { PATHS, LEDGER_FILES, sourcesFile, settingsFile, promptsOverrideDir } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { authStore } = await import("../src/store/auth.ts");

function target(name: string, text?: string): string {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const file = path.join(dir, name);
	if (text !== undefined) fs.writeFileSync(file, text);
	return file;
}
const temps = (dir: string) => fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
const fail = (code: string) => Object.assign(new Error(code), { code });

describe("writeFileAtomicSync", () => {
	it("replaces the file with exactly the given text and leaves no temp file", () => {
		const file = target("record.json", "old");
		writeFileAtomicSync(file, '{\n\t"é": "\u{1F600}"\n}');
		assert.equal(fs.readFileSync(file, "utf-8"), '{\n\t"é": "\u{1F600}"\n}');
		assert.deepEqual(temps(path.dirname(file)), []);
	});

	it("writes binary data and creates files that did not exist", () => {
		const file = target("vectors.f32");
		writeFileAtomicSync(file, new Uint8Array([0, 255, 10, 13]));
		assert.deepEqual([...fs.readFileSync(file)], [0, 255, 10, 13]);
	});

	it("a failed rename throws, keeps the old file whole and removes its temp", (t) => {
		const file = target("record.json", "old");
		t.mock.method(fs, "renameSync", () => {
			throw fail("EIO");
		});
		assert.throws(() => writeFileAtomicSync(file, "new"), { code: "EIO" });
		assert.equal(fs.readFileSync(file, "utf-8"), "old");
		assert.deepEqual(temps(path.dirname(file)), []);
	});

	it("a failed write (disk full) keeps the old file whole and removes its temp", (t) => {
		const file = target("record.json", "old");
		t.mock.method(fs, "fsyncSync", () => {
			throw fail("ENOSPC");
		});
		assert.throws(() => writeFileAtomicSync(file, "new"), { code: "ENOSPC" });
		assert.equal(fs.readFileSync(file, "utf-8"), "old");
		assert.deepEqual(temps(path.dirname(file)), []);
	});

	it("temp names are unique per write", (t) => {
		const file = target("record.json", "old");
		const seen: string[] = [];
		const rename = fs.renameSync;
		t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
			seen.push(String(args[0]));
			return rename(...args);
		});
		writeFileAtomicSync(file, "a");
		writeFileAtomicSync(file, "b");
		assert.equal(new Set(seen).size, 2);
	});

	it("mode applies to the new file", () => {
		const file = target("secret.json", "old");
		writeFileAtomicSync(file, "new", { mode: 0o600 });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});
});

describe("removeLeftoverTemps", () => {
	it("removes only that file's crash leftovers", () => {
		const file = target("chat_a.json", "{}");
		const dir = path.dirname(file);
		for (const name of ["chat_a.json.tmp-1", "chat_a.json.tmp-2", "chat_ab.json.tmp-3", "chat_b.json"]) fs.writeFileSync(path.join(dir, name), "x");
		removeLeftoverTemps(file);
		assert.deepEqual(fs.readdirSync(dir).sort(), ["chat_a.json", "chat_ab.json.tmp-3", "chat_b.json"]);
	});

	it("does nothing when the folder is gone", () => {
		removeLeftoverTemps(path.join(root, "missing", "x.json"));
	});
});

describe("store writers use it", () => {
	it("a failing rename leaves chat, settings, job, sources and prompt records byte-identical", (t) => {
		const chat = chatStore.createChat("kept");
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_atomic" });
		settingsStore.writeSettings({ version: 1 });
		graphStore.upsertSource({ id: "src_a", filePath: "a.md", importedAt: "2026-01-01T00:00:00.000Z" });
		promptOverrides.writeOverride("system-prompt.md", "base");
		const files = [path.join(PATHS.chats, `${chat.id}.json`), path.join(PATHS.data, "jobs", `${job.id}.json`), settingsFile(), sourcesFile(), path.join(promptsOverrideDir(), "system-prompt.md")];
		const before = files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
		t.mock.method(fs, "renameSync", () => {
			throw fail("EIO");
		});
		assert.throws(() => chatStore.renameChat(chat.id, "other"));
		assert.throws(() => jobStore.updateJob(job.id, { status: "done" } as never));
		assert.throws(() => settingsStore.writeSettings({ version: 1, graph: {} } as never));
		assert.throws(() => graphStore.upsertSource({ id: "src_b", filePath: "b.md", importedAt: "2026-01-01T00:00:00.000Z" }));
		assert.throws(() => promptOverrides.writeOverride("system-prompt.md", "changed"));
		t.mock.restoreAll();
		assert.deepEqual(files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null)), before);
		for (const f of files) assert.deepEqual(temps(path.dirname(f)), []);
	});

	it("deletes remove the record's crash leftovers and only theirs", () => {
		const doomed = chatStore.createChat("doomed");
		const keep = chatStore.createChat("kept");
		for (const c of [doomed, keep]) fs.writeFileSync(path.join(PATHS.chats, `${c.id}.json.tmp-crash`), "x");
		assert.equal(chatStore.deleteChat(doomed.id), true);
		assert.deepEqual(temps(PATHS.chats), [`${keep.id}.json.tmp-crash`]);

		const job = jobStore.createJob({ kind: "research", chatId: keep.id, toolCallId: "tc_left" });
		fs.writeFileSync(path.join(PATHS.data, "jobs", `${job.id}.json.tmp-crash`), "x");
		assert.equal(jobStore.deleteJobsForChat(keep.id), 1);
		assert.deepEqual(temps(path.join(PATHS.data, "jobs")), []);

		graphStore.rewriteLedgers({ coverage: [] });
		fs.writeFileSync(`${LEDGER_FILES.coverage}.tmp-crash`, "purged row\n");
		graphStore.rewriteLedgers({ coverage: [] });
		assert.deepEqual(temps(path.dirname(LEDGER_FILES.coverage)), []);

		promptOverrides.writeOverride("system-prompt.md", "custom");
		fs.writeFileSync(path.join(promptsOverrideDir(), "system-prompt.md.tmp-crash"), "x");
		promptOverrides.deleteOverride("system-prompt.md");
		assert.deepEqual(temps(promptsOverrideDir()), []);
	});

	it("the auth store writes 0600 and leaves no temp", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "k");
		const f = process.env.LH_AUTH_FILE!;
		assert.equal(fs.statSync(f).mode & 0o777, 0o600);
		assert.deepEqual(temps(path.dirname(f)), []);
	});
});
