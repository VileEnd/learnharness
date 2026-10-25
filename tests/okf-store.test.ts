/**
 * The OKF bundle's store, freshness service and zip writer, over an isolated
 * LH_DATA_DIR (set before any config-loading import, so every app import is
 * dynamic). No network, no LLM.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import type { OkfFile } from "../src/core/contracts/okf.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import { quiz } from "./learner-helpers.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-okf-store-"));
process.env.LH_DATA_DIR = TMP;
delete process.env.LH_LIBRARY_DIR;

const { PATHS } = await import("../config.ts");
const { okfBundleStore } = await import("../src/store/okf.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { documentStore } = await import("../src/store/documents.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createLibrary } = await import("../src/server/okf.ts");
const { zipFiles } = await import("../src/server/zip.ts");
const { checkOkfConformance } = await import("../src/core/okf.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const node = (id: string, name: string): GraphNode => ({
	id,
	name,
	statement: `${name} holds.`,
	aliases: [],
	createdAt: "2026-10-21T09:00:00.000Z",
	provenance: [],
});

const tmpDirs = () => fs.readdirSync(path.dirname(PATHS.okf)).filter((n) => n.includes(".tmp-") || n.includes(".old-"));

describe("OkfBundleStore", () => {
	it("rebuild is atomic", () => {
		okfBundleStore.replaceAll([{ path: "index.md", content: "# a\n" }]);
		okfBundleStore.writeStamp("s1");
		assert.equal(okfBundleStore.readStamp(), "s1");
		okfBundleStore.replaceAll([{ path: "b.md", content: "b\n" }, { path: "sub/c.md", content: "c\n" }]);
		assert.deepEqual(fs.readdirSync(PATHS.okf).sort(), ["b.md", "sub"], "no .stamp inside the bundle");
		assert.ok(fs.existsSync(`${PATHS.okf}.stamp`));
		fs.rmSync(PATHS.okf, { recursive: true });
		assert.equal(okfBundleStore.readStamp(), null, "a missing bundle never counts as fresh");
		assert.deepEqual(tmpDirs(), []);
	});

	it("refuses a path that would leave the root, leaving the old bundle intact", () => {
		okfBundleStore.replaceAll([{ path: "keep.md", content: "k\n" }]);
		assert.throws(() => okfBundleStore.replaceAll([{ path: "../escape.md", content: "x" }]));
		assert.deepEqual(fs.readdirSync(PATHS.okf), ["keep.md"]);
		assert.deepEqual(tmpDirs(), []);
	});
});

describe("Library", () => {
	const countingStore = () => {
		const calls: OkfFile[][] = [];
		return {
			calls,
			store: {
				...okfBundleStore,
				replaceAll(files: OkfFile[]) {
					calls.push(files);
					okfBundleStore.replaceAll(files);
				},
			},
		};
	};
	const lib = (store: typeof okfBundleStore, settings: () => never = () => null as never, force = true) =>
		createLibrary({ okfStore: store, graphStore, documentStore, chatStore, settings, force, now: () => new Date("2026-10-25T12:00:00Z") });

	it("ensureFresh rebuilds only when sources change", async () => {
		fs.rmSync(PATHS.okf, { recursive: true, force: true });
		const { calls, store } = countingStore();
		const library = lib(store);
		graphStore.appendNode(node("n_aaaaaa11", "First"));
		await Promise.all([library.ensureFresh(), library.ensureFresh()]); // single-flight
		await library.ensureFresh();
		assert.equal(calls.length, 1);
		assert.deepEqual(checkOkfConformance(calls[0]!), []);
		assert.ok(fs.existsSync(path.join(PATHS.okf, "index.md")));
		assert.ok(fs.existsSync(`${PATHS.okf}.stamp`));
		assert.ok(!fs.existsSync(path.join(PATHS.okf, ".stamp")));

		graphStore.appendNode(node("n_bbbbbb22", "Second"));
		await library.ensureFresh();
		assert.equal(calls.length, 2);
		assert.ok(calls[1]!.some((f) => f.path.startsWith("concepts/second-")));
		assert.deepEqual(tmpDirs(), []);
	});

	it("a deleted chat changes the stamp", async () => {
		const library = lib(okfBundleStore);
		const before = library.sourceStamp();
		const chat = chatStore.createChat("Temp session");
		const created = library.sourceStamp();
		assert.notEqual(created, before);
		chatStore.deleteChat(chat.id);
		assert.notEqual(library.sourceStamp(), created);
	});

	it("never builds under NODE_ENV=test unless forced", async () => {
		fs.rmSync(PATHS.okf, { recursive: true, force: true });
		assert.equal(process.env.NODE_ENV, "test");
		const { calls, store } = countingStore();
		await lib(store, () => null as never, false).ensureFresh();
		assert.equal(calls.length, 0);
		assert.equal(fs.existsSync(PATHS.okf), false);
	});

	it("the export ignores agent gates", () => {
		const gated = (() => ({ version: 1, agent: { graphTools: { enabled: false }, documentTools: { enabled: false } } })) as () => never;
		const library = lib(okfBundleStore, gated);
		const files = library.renderExport();
		assert.ok(files.some((f) => f.path.startsWith("concepts/")));
		assert.ok(files.some((f) => f.path === "viz.html"));
	});

	it("the agent bundle applies the gates", async () => {
		fs.rmSync(PATHS.okf, { recursive: true, force: true });
		const gated = (() => ({ version: 1, agent: { graphTools: { enabled: false } } })) as () => never;
		await lib(okfBundleStore, gated).ensureFresh();
		assert.ok(!fs.existsSync(path.join(PATHS.okf, "concepts")));
	});
});


describe("Library learner model", () => {
	it("builds me/ from the chats and the attribution ledger, in the bundle and in the export", async () => {
		fs.rmSync(PATHS.okf, { recursive: true, force: true });
		graphStore.appendNode(node("n_cccccc33", "Tagged concept"));
		graphStore.appendNode(node("n_dddddd44", "Attributed concept"));
		const c = chatStore.createChat("Evidence session");
		chatStore.saveMessages(c.id, [
			...quiz("q1", { pick: 2, thinking: "mixed them up", concepts: ["n_cccccc33"] }),
			...quiz("q2", { pick: 1 }),
		]);
		const ledger = { chatId: c.id, toolCallId: "q2", conceptIds: ["n_dddddd44"], at: "2026-10-25T09:00:00.000Z" };
		const learnerStore = { readAttributions: () => [ledger] };
		const library = createLibrary({
			okfStore: okfBundleStore,
			graphStore,
			documentStore,
			chatStore,
			learnerStore,
			settings: () => null as never,
			force: true,
			now: () => new Date("2026-10-25T12:00:00Z"),
		});
		await library.ensureFresh();
		const page = fs.readdirSync(path.join(PATHS.okf, "me", "concepts"));
		assert.equal(page.length, 2);
		const tagged = fs.readFileSync(path.join(PATHS.okf, "me", "concepts", page.find((p) => p.includes("cccccc"))!), "utf-8");
		assert.match(tagged, /not:\n  - term: "P increments"/);
		assert.match(fs.readFileSync(path.join(PATHS.okf, "me", "concepts", page.find((p) => p.includes("dddddd"))!), "utf-8"), /description: "Learning - 1 clean session/);
		const exported = library.renderExport();
		assert.ok(exported.some((f) => f.path === "me/overview.md"));
		assert.deepEqual(checkOkfConformance(exported.filter((f) => f.path !== "viz.html")), []);
		// graph off: no me/ for the agents
		const gated = (() => ({ version: 1, agent: { graphTools: { enabled: false } } })) as () => never;
		fs.rmSync(PATHS.okf, { recursive: true, force: true });
		await createLibrary({ okfStore: okfBundleStore, graphStore, documentStore, chatStore, learnerStore, settings: gated, force: true }).ensureFresh();
		assert.ok(!fs.existsSync(path.join(PATHS.okf, "me")));
	});
});

describe("zipFiles", () => {
	it("lists every file", () => {
		const files: OkfFile[] = [
			{ path: "index.md", content: "# Index\n".repeat(50) },
			{ path: "concepts/größe-ä.md", content: "ünïcode ✓\n" },
			{ path: "empty.md", content: "" },
		];
		const zip = zipFiles(files);
		assert.equal(zip.subarray(0, 4).toString("latin1"), "PK\x03\x04");
		const end = zip.length - 22;
		assert.equal(zip.readUInt32LE(end), 0x06054b50);
		const count = zip.readUInt16LE(end + 10);
		let p = zip.readUInt32LE(end + 16);
		const found: Array<{ path: string; content: string }> = [];
		for (let i = 0; i < count; i++) {
			assert.equal(zip.readUInt32LE(p), 0x02014b50);
			const crc = zip.readUInt32LE(p + 16);
			const csize = zip.readUInt32LE(p + 20);
			const usize = zip.readUInt32LE(p + 24);
			const nlen = zip.readUInt16LE(p + 28);
			const local = zip.readUInt32LE(p + 42);
			const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf-8");
			const data = zip.subarray(local + 30 + zip.readUInt16LE(local + 26), local + 30 + zip.readUInt16LE(local + 26) + csize);
			const raw = inflateRawSync(data);
			assert.equal(raw.length, usize);
			assert.equal(crc32(raw), crc);
			found.push({ path: name, content: raw.toString("utf-8") });
			p += 46 + nlen;
		}
		assert.deepEqual(found, files);
	});
});
