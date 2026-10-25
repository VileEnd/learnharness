/**
 * The OKF v0.2 renderer (src/core/okf.ts), pure: a hand-built input of 3
 * nodes, 1 chain (n1 + n2 -> n3), 2 topics, 1 document with 2 sections and
 * 1 chat. No stores, no I/O.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentMeta } from "../src/core/contracts/documents.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { OkfInput } from "../src/core/contracts/okf.ts";
import { checkOkfConformance, okfFrontmatter, okfSlug, renderOkfBundle, topicPath } from "../src/core/okf.ts";

const TEXT = "# Semaphores\nP and V are atomic.\n\n# Monitors\nA monitor bundles data and locks.\n";
const META: DocumentMeta = {
	id: "doc_abcdef123456",
	contentHash: "h",
	minhash: [],
	title: "Blatt 4",
	summary: "Locks and signals.",
	topics: ["Semaphoren"],
	filenames: ["blatt4.md"],
	importedAt: "2026-10-20T10:00:00.000Z",
	updatedAt: "2026-10-20T10:00:00.000Z",
	origin: "markdown",
	sourceId: "doc_abcdef123456",
	sections: [
		{ id: "s1", headingPath: ["Semaphores"], start: 0, end: 41 },
		{ id: "s2", headingPath: ["Monitors"], start: 41, end: TEXT.length, pageFrom: 3 },
	],
};

const node = (id: string, name: string, prov: GraphNode["provenance"], extra: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} holds.`,
	aliases: [],
	createdAt: "2026-10-21T09:00:00.000Z",
	provenance: prov,
	...extra,
});

function input(over: Partial<OkfInput> = {}): OkfInput {
	return {
		nodes: [
			node("n_111111aa", "Critical section", [{ chatId: META.sourceId, messageId: "m", section: "s1" }]),
			node("n_222222bb", "Indivisible instructions", [{ chatId: "c1", messageId: "m" }]),
			node("n_333333cc", "Mutual exclusion with semaphores", [{ chatId: "c1", messageId: "m" }, { chatId: META.sourceId, messageId: "m", section: "s2" }], {
				aliases: ["mutex via P/V"],
			}),
		],
		chains: [{ id: "arg_1", premises: ["n_111111aa", "n_222222bb"], conclusion: "n_333333cc", provenance: [], createdAt: "2026-10-21T09:00:00.000Z" }],
		topics: [
			{ nodeId: "n_111111aa", topic: "Semaphoren", sourceId: META.sourceId, at: "2026-10-21T09:00:00.000Z" },
			{ nodeId: "n_333333cc", topic: "C++", sourceId: "c1", at: "2026-10-21T09:00:00.000Z" },
		],
		aliases: {},
		documents: [{ meta: META, text: TEXT }],
		chats: [{ id: "c1", title: "Semaphores", createdAt: "2026-10-20T08:00:00.000Z" }],
		gates: { documents: true, graph: true },
		now: "2026-10-25T12:00:00.000Z",
		...over,
	};
}

type Files = { path: string; content: string }[];
const get = (files: Files, pred: (p: string) => boolean) => files.find((f) => pred(f.path));
const concept = (files: Files, id: string) => get(files, (p) => p.startsWith("concepts/") && p.includes(id.slice(2, 8)))!;

test("concept file has the v0.2 frontmatter", () => {
	const files = renderOkfBundle(input());
	const n3 = concept(files, "n_333333cc");
	assert.ok(n3.content.startsWith('---\ntype: "Proposition"\ntitle: "Mutual exclusion with semaphores"\n'));
	const keys = [...n3.content.slice(4, n3.content.indexOf("\n---\n")).matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
	assert.deepEqual(keys, ["type", "title", "description", "tags", "id", "status", "generated", "verified", "sources"]);
	assert.match(n3.content, /resource: "\.\.\/documents\/blatt-4-abcdef\/s2-monitors\.md"/);
	assert.match(n3.content, /resource: "learnharness:chat\/c1"/);
	assert.match(n3.content, /## Follows from\n- \[Critical section\]\(critical-section-111111\.md\) \+ \[Indivisible instructions\]\(indivisible-instructions-222222\.md\)/);
	assert.match(n3.content, /## Also phrased as\n- mutex via P\/V/);
	assert.match(concept(files, "n_111111aa").content, /## Leads to\n- \[Mutual exclusion with semaphores\]\(.*\) \(together with \[Indivisible instructions\]/);
});

test("index files carry no frontmatter except the root okf_version", () => {
	const files = renderOkfBundle(input());
	for (const f of files.filter((f) => f.path.endsWith("/index.md"))) assert.ok(!f.content.startsWith("---"), f.path);
	assert.ok(get(files, (p) => p === "index.md")!.content.startsWith('---\nokf_version: "0.2"\n---'));
});

test("rendering is deterministic", () => {
	assert.deepEqual(renderOkfBundle(input()), renderOkfBundle(input()));
});

test("okfSlug keeps distinct titles distinct", () => {
	assert.notEqual(topicPath("C++"), topicPath("C#"));
	assert.equal(okfSlug("Größe & Übung", "ab12"), "groesse-uebung-ab12");
	assert.match(topicPath("C++"), /^topics\/c-plus-plus-[0-9a-f]{4}\.md$/);
	assert.ok(okfSlug("x".repeat(200), "ab12").length <= 60 + 5);
	assert.equal(okfSlug("🙂🙂", "ab12"), "item-ab12");
});

test("dangling chain premises are skipped", () => {
	const i = input({
		chains: [
			{ id: "arg_1", premises: ["n_111111aa", "n_gone0000"], conclusion: "n_333333cc", provenance: [], createdAt: "x" },
			{ id: "arg_2", premises: ["n_111111aa"], conclusion: "n_missing0", provenance: [], createdAt: "x" },
		],
	});
	const files = renderOkfBundle(i);
	assert.ok(files.every((f) => !f.content.includes("gone0000") && !f.content.includes("missing0")));
	assert.ok(!concept(files, "n_333333cc").content.includes("## Follows from"));
	assert.deepEqual(checkOkfConformance(files), []);
});

test("untagged concepts stay reachable", () => {
	const files = renderOkfBundle(input());
	const idx = get(files, (p) => p === "concepts/index.md")!.content;
	assert.match(idx, /# Untagged\n\n\* \[Indivisible instructions\]/);
	assert.match(idx, /# Proposition\n/);
	assert.match(get(files, (p) => p === "topics/index.md")!.content, /# Untagged\n\n\* \[Concepts without a topic\]\(\.\.\/concepts\/index\.md\)/);
});

test("gates remove gated content everywhere", () => {
	const noGraph = renderOkfBundle(input({ gates: { documents: true, graph: false } }));
	assert.ok(noGraph.every((f) => !f.path.startsWith("concepts/") && !f.path.startsWith("me/")));
	for (const f of noGraph) for (const n of input().nodes) assert.ok(!f.content.includes(n.name), `${f.path} leaks ${n.name}`);
	assert.deepEqual(checkOkfConformance(noGraph), []);

	const noDocs = renderOkfBundle(input({ gates: { documents: false, graph: true } }));
	assert.ok(noDocs.every((f) => !f.path.startsWith("documents/")));
	for (const f of noDocs) assert.ok(!f.content.includes("documents/"), `${f.path} links documents/`);
	assert.deepEqual(checkOkfConformance(noDocs), []);

	const none = renderOkfBundle(input({ gates: { documents: false, graph: false } }));
	assert.deepEqual(none.map((f) => f.path), ["index.md", "log.md"]);
	assert.deepEqual(checkOkfConformance(none), []);
});

test("trust and lifecycle fields", () => {
	const files = renderOkfBundle(input());
	const n3 = concept(files, "n_333333cc").content;
	assert.equal(n3.match(/^ {2}- by: "learnharness\/auditor"$/gm)?.length, 1);
	assert.match(n3, /status: "stable"/);
	assert.ok(!concept(files, "n_111111aa").content.includes("verified"));
	const orphan = input({ nodes: [node("n_444444dd", "Orphan", [{ chatId: "deleted-chat", messageId: "m" }])], chains: [] });
	assert.match(concept(renderOkfBundle(orphan), "n_444444dd").content, /status: "deprecated"/);
	const legacy = input({ nodes: [node("n_555555ee", "Legacy import", [{ chatId: "src_d29e7ef2599a", messageId: "" }])], chains: [] });
	assert.match(concept(renderOkfBundle(legacy), "n_555555ee").content, /status: "stable"/);
});

test("index files use the reference format", () => {
	const files = renderOkfBundle(input());
	const idx = get(files, (p) => p === "concepts/index.md")!.content;
	assert.ok(idx.includes("# Proposition"));
	const entries = idx.split("\n").filter((l) => l.startsWith("* "));
	assert.equal(entries.length, 3);
	for (const e of entries) assert.match(e, /^\* \[.+\]\(.+\.md\)( - .+)?$/);
	const docs = get(files, (p) => p === "documents/index.md")!.content;
	assert.match(docs, /# Document\n\n\* \[Blatt 4\]\(blatt-4-abcdef\.md\) - Locks and signals\.\n\n# Subdirectories\n\n\* \[blatt-4-abcdef\]\(blatt-4-abcdef\/index\.md\)/);
});

test("the full render is conformant", () => {
	const files = renderOkfBundle(input());
	assert.deepEqual(checkOkfConformance(files), []);
	const broken = files.map((f) => (f.path === "topics/index.md" ? { ...f, content: `${f.content}\n[x](nowhere.md)\n` } : f));
	assert.ok(checkOkfConformance(broken).length > 0);
	const noType = files.map((f) => (f.path.startsWith("concepts/c") ? { ...f, content: f.content.replace(/type: "[^"]*"\n/, "") } : f));
	assert.ok(checkOkfConformance(noType).some((p) => p.includes("missing type")));
});

test("log.md lists ISO dates newest first", () => {
	const log = get(renderOkfBundle(input()), (p) => p === "log.md")!.content;
	const dates = [...log.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
	assert.deepEqual(dates, ["2026-10-25", "2026-10-21", "2026-10-20"]);
});

test("okfFrontmatter quotes strings and keeps order", () => {
	assert.equal(
		okfFrontmatter({ type: "T", title: 'a "q"\nb', tags: ["x", "y"], n: 3, g: { by: "me" }, s: [{ id: "1", resource: "r" }], e: [] }),
		'---\ntype: "T"\ntitle: "a \\"q\\"\\nb"\ntags: ["x", "y"]\nn: 3\ng: { by: "me" }\ns:\n  - id: "1"\n    resource: "r"\ne: []\n---\n',
	);
});
