/**
 * Noweb documents in the library: a new .nw file is converted on import, and an
 * old import can be rebuilt. The rebuild's promise is the point of these tests:
 * the text improves at once, and the existing concepts are only given up after
 * a complete extraction has replaced them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-rebuild-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.OCR_URL;

const { createDocumentService } = await import("../src/server/documents.ts");
const { documentStore } = await import("../src/store/documents.ts");
const { createOcrClient } = await import("../src/server/ocr-client.ts");
const { NotesImportError } = await import("../src/agent/subagents/extraction.ts");
const { fingerprint } = await import("../src/core/documents.ts");
const { retireSource } = await import("../src/core/graph-deletion.ts");
const { extraction } = await import("../src/server/chat-handler.ts");
const { stores } = await import("../src/server/stores.ts");
const rebuildRoute = await import("../app/api/documents/[id]/rebuild/route.ts");
import type { EmissionStats } from "../src/core/graph.ts";
import type { NotesImportInput } from "../src/agent/subagents/extraction.ts";
import type { ExtractionRunUsage, GraphNode } from "../src/core/contracts.ts";
import { memoryGraphStore } from "./memory-graph-store.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(TMP_DATA, "documents"), { recursive: true, force: true }));

const AT = "2026-10-24T21:23:52.934Z";
const OLD_ID = "doc_0123456789ab";
const OLD_SOURCE = "src_0123456789ab";
const prose = (salt: string) => Array.from({ length: 120 }, (_, i) => `word${i}${salt}`).join(" ");
const nw = (salt = "") => `\\documentclass{book}\n\\begin{document}\n\\chapter{Memory}\n${prose(salt)}\n<<kernel.c>>=\n#include <stdio.h>\n@ %def main\n\\end{document}\n`;

/** A .nw that went in as plain text, before the library could read one. */
function seedOldImport(text = nw(), filename = "book.nw"): void {
	documentStore.save(
		{
			id: OLD_ID,
			...fingerprint(text),
			title: "The Book",
			summary: "s",
			topics: ["OS"],
			filenames: [filename],
			importedAt: AT,
			updatedAt: AT,
			origin: "markdown",
			sourceId: OLD_SOURCE,
		},
		text,
	);
}

const node = (id: string, chatId: string): GraphNode => ({
	id,
	name: id,
	statement: `${id} statement`,
	aliases: [],
	createdAt: AT,
	provenance: [{ chatId, messageId: "" }],
});

function harness(over: {
	importNotes?: (input: NotesImportInput) => Promise<EmissionStats>;
	sourceBusy?: (id: string) => boolean;
	/** Concepts the old source fed before the rebuild. */
	oldConcepts?: number;
	/** Concepts each default extraction finds. */
	finds?: number;
} = {}) {
	const extracted: NotesImportInput[] = [];
	const retired: [string, string][] = [];
	const sourceWhenRetired: (string | undefined)[] = [];
	const events = { rebuilt: 0 };
	const graph = memoryGraphStore();
	for (let i = 0; i < (over.oldConcepts ?? 0); i++) graph.appendNode(node(`old_${i}`, OLD_SOURCE));
	const service = createDocumentService({
		store: documentStore,
		graph,
		importNotes: async (input) => {
			extracted.push(input);
			if (over.importNotes) return over.importNotes(input);
			const finds = over.finds ?? 3;
			for (let i = 0; i < finds; i++) graph.appendNode(node(`new_${i}`, input.id!));
			return { nodes: finds, chains: 0 };
		},
		describe: async () => ({ title: "Described", summary: "s", topics: ["OS"] }),
		ocr: createOcrClient({ baseUrl: () => undefined }),
		notify: () => {},
		retireSource: (oldId, newId) => {
			retired.push([oldId, newId]);
			sourceWhenRetired.push(documentStore.getMeta(OLD_ID)?.sourceId);
		},
		sourceBusy: over.sourceBusy,
		onRebuilt: () => void events.rebuilt++,
		pollMs: 0,
	});
	return { service, extracted, retired, sourceWhenRetired, events, graph };
}

const started = (ticket: ReturnType<ReturnType<typeof harness>["service"]["rebuild"]>) => {
	assert.ok(ticket.ok, "the rebuild should start");
	return ticket;
};

describe("importing a .nw file", () => {
	const file = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });

	it("is stored converted, with real sections, and needs no rebuild", async () => {
		const { service, extracted } = harness();
		const [ticket] = await service.importFiles([file("book.nw", nw())]);
		await ticket!.completion;
		const found = service.get(ticket!.docId!)!;
		assert.ok(found.markdown.startsWith("# Memory"));
		assert.ok(found.markdown.includes("`<<kernel.c>>=`\n```\n#include <stdio.h>\n```"));
		assert.deepEqual(found.meta.sections.map((s) => s.headingPath), [["Memory"]]);
		assert.equal(extracted.length, 1);
		assert.equal(extracted[0]!.id, ticket!.docId);
		assert.equal(found.rebuild, undefined);
	});

	it("a second upload of the same file is a duplicate", async () => {
		const { service } = harness();
		const [ticket] = await service.importFiles([file("book.nw", nw())]);
		await ticket!.completion;
		const [check] = await service.check([file("renamed.nw", nw())]);
		assert.equal(check!.verdict.status, "duplicate");
	});

	it("a text file with chunk-like lines is not converted", async () => {
		const { service } = harness();
		const [ticket] = await service.importFiles([file("notes.md", nw())]);
		await ticket!.completion;
		assert.equal(service.get(ticket!.docId!)!.markdown, nw());
	});
});

describe("offering a rebuild", () => {
	it("an old .nw import is offered one, sized in extraction chunks", () => {
		seedOldImport();
		assert.deepEqual(harness().service.get(OLD_ID)!.rebuild, { chunks: 1 });
	});

	it("any other document is not, and refuses one", () => {
		seedOldImport(nw(), "notes.md");
		const { service, extracted } = harness();
		assert.equal(service.get(OLD_ID)!.rebuild, undefined);
		const ticket = service.rebuild(OLD_ID);
		assert.ok(!ticket.ok);
		assert.equal(ticket.code, "not_rebuildable");
		assert.equal(extracted.length, 0);
	});

	it("an unknown document is not found", () => {
		const ticket = harness().service.rebuild("doc_ffffffffffff");
		assert.ok(!ticket.ok);
		assert.equal(ticket.code, "not_found");
	});
});

describe("rebuilding", () => {
	it("converts the text at once, and keeps the old concepts while extraction runs", async () => {
		seedOldImport();
		let finish!: (stats: EmissionStats) => void;
		const { service, extracted, retired, sourceWhenRetired, events, graph } = harness({
			importNotes: (input) =>
				new Promise<EmissionStats>((resolve) => {
					finish = resolve;
					graph.appendNode(node("new_0", input.id!));
				}),
		});
		const ticket = started(service.rebuild(OLD_ID));

		const during = documentStore.getMeta(OLD_ID)!;
		assert.ok(documentStore.readMarkdown(OLD_ID)!.startsWith("# Memory"));
		assert.deepEqual(during.sections.map((s) => s.headingPath), [["Memory"]]);
		assert.equal(during.sourceId, OLD_SOURCE, "the document still points at the old concepts");
		assert.deepEqual([during.title, during.topics, during.importedAt], ["The Book", ["OS"], AT], "only the text changed");
		assert.equal(retired.length, 0);

		await new Promise((resolve) => setImmediate(resolve));
		const newSource = extracted[0]!.id!;
		assert.notEqual(newSource, OLD_SOURCE, "extraction writes to a source of its own");
		assert.equal(extracted[0]!.title, "The Book");
		assert.deepEqual(extracted[0]!.sections!.map((s) => s.headingPath), [["Memory"]]);

		finish({ nodes: 3, chains: 1 });
		const done = await ticket.completion;
		assert.equal(done.ok, true);
		assert.deepEqual(retired, [[OLD_SOURCE, newSource]]);
		assert.equal(documentStore.getMeta(OLD_ID)!.sourceId, newSource);
		assert.deepEqual(sourceWhenRetired, [newSource], "a crash in between must not lose the concepts and ask to pay again");
		assert.equal(events.rebuilt, 1);
	});

	it("once done it is not offered again", async () => {
		seedOldImport();
		const { service } = harness();
		await started(service.rebuild(OLD_ID)).completion;
		assert.equal(service.get(OLD_ID)!.rebuild, undefined);
		const again = service.rebuild(OLD_ID);
		assert.ok(!again.ok);
		assert.equal(again.code, "not_rebuildable");
	});

	it("a failed run gives up nothing, and a retry continues under the same source", async () => {
		seedOldImport();
		const failing = harness({
			importNotes: async () => {
				throw new NotesImportError("partial", { nodes: 1, chains: 0 }, "chunk 2 failed");
			},
		});
		const done = await started(failing.service.rebuild(OLD_ID)).completion;
		assert.deepEqual([done.ok, done.outcome], [false, "partial"]);
		assert.equal(failing.retired.length, 0);
		assert.equal(failing.events.rebuilt, 0);
		assert.equal(documentStore.getMeta(OLD_ID)!.sourceId, OLD_SOURCE);
		assert.ok(documentStore.readMarkdown(OLD_ID)!.startsWith("# Memory"), "the converted text stays");
		assert.deepEqual(failing.service.get(OLD_ID)!.rebuild, { chunks: 1 }, "it can be retried");

		const retry = harness();
		await started(retry.service.rebuild(OLD_ID)).completion;
		assert.equal(retry.extracted[0]!.id, failing.extracted[0]!.id);
		assert.deepEqual(retry.retired, [[OLD_SOURCE, failing.extracted[0]!.id]]);
	});

	it("a run that extracted nothing does not wipe the old concepts", async () => {
		seedOldImport();
		const { service, retired } = harness({ importNotes: async () => ({ nodes: 0, chains: 0 }) });
		const done = await started(service.rebuild(OLD_ID)).completion;
		assert.equal(done.ok, false);
		assert.equal(retired.length, 0);
		assert.equal(documentStore.getMeta(OLD_ID)!.sourceId, OLD_SOURCE);
	});

	it("a run that found far fewer concepts than the document had removes nothing", async () => {
		seedOldImport();
		const { service, retired } = harness({ oldConcepts: 40, finds: 3 });
		const done = await started(service.rebuild(OLD_ID)).completion;
		assert.equal(done.ok, false);
		assert.match(done.error!, /only 3 concepts.*had 40/);
		assert.equal(retired.length, 0);
		assert.equal(documentStore.getMeta(OLD_ID)!.sourceId, OLD_SOURCE);
	});

	it("concepts the new run matched to existing ones count as found", async () => {
		seedOldImport();
		const harnessed = harness({
			oldConcepts: 8,
			// Every finding links to an old concept: nothing new is created.
			importNotes: async (input) => {
				for (let i = 0; i < 8; i++) harnessed.graph.appendNode(node(`old_${i}`, input.id!));
				return { nodes: 0, chains: 0 };
			},
		});
		const done = await started(harnessed.service.rebuild(OLD_ID)).completion;
		assert.equal(done.ok, true);
		assert.equal(harnessed.retired.length, 1);
	});

	it("keeps a new title set during the run", async () => {
		seedOldImport();
		const { service } = harness();
		const ticket = started(service.rebuild(OLD_ID));
		documentStore.save({ ...documentStore.getMeta(OLD_ID)!, title: "Renamed" }, documentStore.readMarkdown(OLD_ID)!);
		await ticket.completion;
		assert.equal(documentStore.getMeta(OLD_ID)!.title, "Renamed");
	});

	it("removes nothing if the document was replaced during the run", async () => {
		seedOldImport();
		const { service, retired } = harness();
		const ticket = started(service.rebuild(OLD_ID));
		const replaced = "# Something else entirely\n\nOther text.";
		documentStore.save({ ...documentStore.getMeta(OLD_ID)!, ...fingerprint(replaced) }, replaced);
		const done = await ticket.completion;
		assert.equal(done.ok, false);
		assert.equal(retired.length, 0);
		assert.equal(documentStore.readMarkdown(OLD_ID), replaced);
		assert.equal(documentStore.getMeta(OLD_ID)!.sourceId, OLD_SOURCE);
	});

	it("a second press while one is running is refused", async () => {
		seedOldImport();
		let finish!: (stats: EmissionStats) => void;
		const { service, extracted, graph } = harness({
			importNotes: (input) =>
				new Promise<EmissionStats>((resolve) => {
					finish = resolve;
					graph.appendNode(node("new_0", input.id!));
				}),
		});
		const first = started(service.rebuild(OLD_ID));
		const second = service.rebuild(OLD_ID);
		assert.ok(!second.ok);
		assert.equal(second.code, "busy");
		await new Promise((resolve) => setImmediate(resolve));
		finish({ nodes: 1, chains: 0 });
		await first.completion;
		assert.equal(extracted.length, 1);
	});

	it("waits for an import still running on the old source", () => {
		seedOldImport();
		const { service, extracted } = harness({ sourceBusy: (id) => id === OLD_SOURCE });
		const ticket = service.rebuild(OLD_ID);
		assert.ok(!ticket.ok);
		assert.equal(ticket.code, "busy");
		assert.equal(extracted.length, 0);
		assert.ok(documentStore.readMarkdown(OLD_ID)!.startsWith("\\documentclass"), "nothing changed");
	});
});

describe("retireSource", () => {
	it("removes what only the old source fed, keeps what the new one also fed, and moves its usage", () => {
		const graph = memoryGraphStore();
		graph.upsertSource({ id: "old", filePath: "t", importedAt: AT });
		graph.upsertSource({ id: "new", filePath: "t", importedAt: AT });
		const usage = { startedAt: 1, at: AT, durationMs: 5 } as ExtractionRunUsage;
		graph.appendSourceUsage("old", usage);
		graph.appendNode(node("only_old", "old"));
		graph.appendNode(node("matched", "old"));
		graph.appendNode(node("matched", "new"));
		graph.appendNode(node("only_new", "new"));

		const stats = retireSource(graph, "old", "new");

		assert.equal(stats.nodesRemoved, 1);
		assert.deepEqual([...new Set(graph.readNodes().map((n) => n.id))].sort(), ["matched", "only_new"]);
		assert.deepEqual(graph.readSources().map((s) => s.id), ["new"]);
		assert.deepEqual(graph.readSources()[0]!.extractions, [usage], "what was spent still counts");
	});
});

describe("POST /api/documents/[id]/rebuild", () => {
	const post = (id: string) =>
		rebuildRoute.POST(new Request(`http://localhost/api/documents/${id}/rebuild`, { method: "POST" }), { params: Promise.resolve({ id }) });
	const original = extraction.importNotes;
	after(() => {
		extraction.importNotes = original;
	});

	it("answers 404 for an unknown document and 409 for one it cannot rebuild", async () => {
		assert.equal((await post("doc_ffffffffffff")).status, 404);
		seedOldImport(nw(), "notes.md");
		assert.equal((await post(OLD_ID)).status, 409);
	});

	it("answers 202 at once; the work carries on and finishes in the background", async () => {
		seedOldImport();
		extraction.importNotes = async (input) => {
			stores.graphStore.appendNode(node("route_new", input.id!));
			return { nodes: 1, chains: 0 };
		};
		const res = await post(OLD_ID);
		assert.equal(res.status, 202);
		assert.deepEqual(await res.json(), { ok: true, docId: OLD_ID });
		for (let i = 0; i < 100 && documentStore.getMeta(OLD_ID)!.sourceId === OLD_SOURCE; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.notEqual(documentStore.getMeta(OLD_ID)!.sourceId, OLD_SOURCE);
	});
});
