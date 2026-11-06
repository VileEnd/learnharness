/**
 * The document library's UI, statically: the Add-documents body (status
 * badges, the decision choices per verdict, what will be sent), the library
 * list (aliases, topics, search) and the reader (page anchors, no broken
 * page images). Pure bodies via renderToStaticMarkup; the stateful wrappers
 * (fetch, portal) are exercised by the app itself.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddDocumentsBody, choicesFor, statusLabel, willImport, type Entry } from "../components/add-documents-dialog.tsx";
import { DocumentsLibraryBody, matchesQuery } from "../components/documents-library.tsx";
import { DocumentReaderBody, RebuildPanel, withoutPageImages, type RebuildPhase } from "../components/document-reader.tsx";
import { DeleteDocumentBody, removalLines } from "../components/delete-document-dialog.tsx";
import type { DocumentSummary } from "../src/core/index.ts";

const of = { id: "doc_aaaaaaaaaaaa", title: "Mutex basics", importedAt: "2026-10-01T10:00:00.000Z" };
const ready = (key: number, name: string, verdict: Entry["check"] extends infer C ? (C extends { verdict: infer V } ? V : never) : never, kind: "markdown" | "pdf" = "markdown"): Entry => ({
	key, name, state: "ready", check: { index: key, name, kind, verdict },
});

describe("Add documents", () => {
	const entries: Entry[] = [
		ready(1, "fresh.md", { status: "new" }),
		ready(2, "again.md", { status: "duplicate", of, score: 1 }),
		ready(3, "edited.md", { status: "similar", of, score: 0.923 }),
		{ ...ready(4, "scan.pdf", { status: "new" }, "pdf"), usd: 0.42, pages: 12 },
		{ key: 5, name: "x.bin", state: "error", error: "Not a text or PDF file." },
	];
	const render = (decisions = {}) =>
		renderToStaticMarkup(createElement(AddDocumentsBody, {
			entries, decisions, phase: "pick", results: [], onPick: () => {}, onRemove: () => {}, onDecide: () => {}, onClose: () => {}, onImport: () => {},
		}));

	it("labels each verdict from the content match, never the filename", () => {
		assert.equal(statusLabel({ status: "new" }), "New");
		assert.match(statusLabel({ status: "duplicate", of }), /^Already imported as Mutex basics · /);
		assert.equal(statusLabel({ status: "similar", of, score: 0.923 }), "92% similar to Mutex basics");
		const html = render();
		assert.ok(html.includes("92% similar to Mutex basics"));
		assert.ok(html.includes("scan ≈ $0.42") && html.includes("12 pages"));
		assert.ok(html.includes("Not a text or PDF file."));
	});

	it("offers Skip/Replace for a duplicate and Skip/Replace/Import as new for a near-duplicate", () => {
		assert.deepEqual(choicesFor({ status: "new" }), []);
		assert.deepEqual(choicesFor({ status: "duplicate", of }), ["skip", "replace"]);
		assert.deepEqual(choicesFor({ status: "similar", of, score: 0.9 }), ["skip", "replace", "new"]);
		const html = render();
		assert.equal(html.split("Import as new").length - 1, 1);
		assert.ok(html.includes('aria-checked="true"'), "skip is the default");
	});

	it("sends new files and non-skipped matches only; the summary says so", () => {
		assert.deepEqual(entries.filter((e) => willImport(e, {})).map((e) => e.key), [1, 4]);
		assert.deepEqual(entries.filter((e) => willImport(e, { 3: "replace", 2: "skip" })).map((e) => e.key), [1, 3, 4]);
		assert.ok(render({ 3: "new" }).includes("3 to add, 1 skipped"));
	});

	it("an old import of the file is 'legacy': attach by default, re-extract or skip as alternatives", () => {
		const legacy = { status: "legacy" as const, legacy: { sourceId: "src_d29e7ef2599a", importedAt: "2026-09-30T14:48:11.111Z", nodeCount: 42 } };
		assert.match(statusLabel(legacy), /^Already in your graph · imported .+ · 42 nodes — add to library \(no re-extraction\)$/);
		assert.deepEqual(choicesFor(legacy), ["attach", "new", "skip"]);
		const only: Entry[] = [{ ...ready(1, "learn database.md", legacy), check: { ...ready(1, "learn database.md", legacy).check!, legacyEmpty: undefined } }];
		assert.ok(willImport(only[0]!, {}), "attach is the default, so it is sent");
		assert.ok(!willImport(only[0]!, { 1: "skip" }));
		const html = renderToStaticMarkup(createElement(AddDocumentsBody, {
			entries: only, decisions: {}, phase: "pick", results: [], onPick: () => {}, onRemove: () => {}, onDecide: () => {}, onClose: () => {}, onImport: () => {},
		}));
		assert.ok(html.includes("Add to library") && html.includes("Re-extract") && html.includes("Skip"));
		assert.match(html, /aria-checked="true"[^>]*>Add to library/);
	});

	it("shows the hint when the old import of the file produced nothing", () => {
		const e: Entry = { ...ready(1, "notes.pdf", { status: "new" }, "pdf"), check: { index: 1, name: "notes.pdf", kind: "pdf", verdict: { status: "new" }, legacyEmpty: { sourceId: "src_x", importedAt: "2026-09-30T00:00:00.000Z" } } };
		const html = renderToStaticMarkup(createElement(AddDocumentsBody, {
			entries: [e], decisions: {}, phase: "pick", results: [], onPick: () => {}, onRemove: () => {}, onDecide: () => {}, onClose: () => {}, onImport: () => {},
		}));
		assert.ok(html.includes("the old import of this file produced nothing"));
	});

	it("offers Add folder (and the skipped notice) only where the folder picker exists", () => {
		const base = { entries: [], decisions: {}, phase: "pick" as const, results: [], onPick: () => {}, onRemove: () => {}, onDecide: () => {}, onClose: () => {}, onImport: () => {} };
		const without = renderToStaticMarkup(createElement(AddDocumentsBody, base));
		assert.ok(!without.includes("add-documents-pick-folder") && !without.includes("webkitdirectory"));
		const withFolder = renderToStaticMarkup(createElement(AddDocumentsBody, { ...base, onPickFolder: () => {}, notice: "2 hidden files skipped." }));
		assert.ok(withFolder.includes("add-documents-pick-folder") && withFolder.includes("Add folder") && withFolder.includes("webkitdirectory"));
		assert.ok(withFolder.includes("2 hidden files skipped."));
	});

	it("is the full-screen-on-phones frame", () => {
		const html = render();
		assert.ok(html.includes('role="dialog"') && html.includes("h-dvh") && html.includes("max-sm:pt-safe"));
	});
});

const doc = (over: Partial<DocumentSummary> = {}): DocumentSummary => ({
	id: "doc_aaaaaaaaaaaa", contentHash: "h", title: "Mutex basics", summary: "How locks work.", topics: ["Mutex", "Semaphor"],
	filenames: ["1.md", "notes final.md"], importedAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z",
	origin: "markdown", sections: [], sourceId: "doc_aaaaaaaaaaaa", ...over,
});

describe("Documents library", () => {
	it("lists title, topics, pages, date and filenames as aliases, linking to the reader", () => {
		const html = renderToStaticMarkup(createElement(DocumentsLibraryBody, { documents: [doc({ origin: "pdf", pages: 7 })], query: "", onQuery: () => {}, onAdd: () => {} }));
		assert.ok(html.includes('href="/documents/doc_aaaaaaaaaaaa"'));
		assert.ok(html.includes("Scanned PDF · 7 pages · 2026-10-01"));
		assert.ok(html.includes("Semaphor"));
		assert.ok(html.includes("1.md · notes final.md"));
	});
	it("empty state, and search over title, topics and aliases", () => {
		const empty = renderToStaticMarkup(createElement(DocumentsLibraryBody, { documents: [], query: "", onQuery: () => {}, onAdd: () => {} }));
		assert.ok(empty.includes("documents-empty"));
		assert.ok(matchesQuery(doc(), "semaphor") && matchesQuery(doc(), "FINAL") && matchesQuery(doc(), "lock"));
		assert.ok(!matchesQuery(doc(), "unrelated"));
	});
});

describe("Rebuilding from the reader", () => {
	const panel = (phase: RebuildPhase, error?: string) =>
		renderToStaticMarkup(createElement(RebuildPanel, { chunks: 118, phase, error, onAsk: () => {}, onConfirm: () => {}, onCancel: () => {} }));

	it("only a document that can be rebuilt shows the panel", () => {
		const reader = (rebuild?: { chunks: number }) =>
			renderToStaticMarkup(createElement(DocumentReaderBody, { meta: doc(), markdown: "# x", rebuild }));
		assert.ok(!reader().includes("Rebuild index"));
		assert.ok(reader({ chunks: 3 }).includes("Rebuild index"));
	});

	it("asks first, naming the model calls and that old concepts stay until it succeeds", () => {
		assert.ok(!panel("idle").includes("236"));
		const asking = panel("confirm");
		assert.ok(asking.includes("about 118 chunks"));
		assert.ok(asking.includes("at least 236 model calls"));
		assert.ok(asking.includes("current concepts stay"));
		assert.ok(asking.includes("Start rebuild"));
	});

	it("says where to follow it once started, and shows a refusal", () => {
		assert.ok(panel("started").includes("activity"));
		assert.ok(!panel("started").includes("Start rebuild"));
		assert.ok(panel("idle", "Already running.").includes("Already running."));
	});
});

describe("Document reader", () => {
	const md = "---\ntitle: x\n---\n<!-- page 1 -->\n![page 1](x/images/p001.png)\n\n# First\nHello\n<!-- page 2 -->\nWorld";
	it("anchors every page as #p-N with a nav, and drops the unstored page images", () => {
		const html = renderToStaticMarkup(createElement(DocumentReaderBody, { meta: doc({ pages: 2 }), markdown: md }));
		assert.ok(html.includes('id="p-1"') && html.includes('id="p-2"'));
		assert.ok(html.includes('href="#p-2"'));
		assert.ok(!html.includes("p001.png"));
		assert.ok(html.includes("Also known as 1.md"));
		assert.equal(withoutPageImages("a\n![page 3](x.png)\nb"), "a\nb");
	});
});

describe("Deleting and renaming from the reader", () => {
	it("the reader offers Delete and Rename only when wired", () => {
		const plain = renderToStaticMarkup(createElement(DocumentReaderBody, { meta: doc(), markdown: "# x" }));
		assert.ok(!plain.includes("document-delete") && !plain.includes("document-rename"));
		const wired = renderToStaticMarkup(createElement(DocumentReaderBody, { meta: doc(), markdown: "# x", onDelete: () => {}, onRename: async () => {} }));
		assert.ok(wired.includes("document-delete") && wired.includes("document-rename"));
	});

	it("the confirm says how many concepts go and how many shared ones stay", () => {
		assert.deepEqual(removalLines({ concepts: 1, shared: 0 }), ["1 concept is supported only by this document and will be deleted from the knowledge graph."]);
		const html = renderToStaticMarkup(
			createElement(DeleteDocumentBody, { title: "Mutex basics", removal: { concepts: 12, shared: 3 }, busy: false, failure: null, onClose: () => {}, onRun: () => {} }),
		);
		assert.ok(html.includes("Mutex basics") && html.includes("12 concepts are supported only by this document"));
		assert.ok(html.includes("3 concepts are also supported by other documents or sessions and will stay"));
		assert.ok(!html.includes("delete-document-failure"));
		const failed = renderToStaticMarkup(
			createElement(DeleteDocumentBody, { title: "t", removal: { concepts: 0, shared: 0 }, busy: false, failure: "An extraction is running.", onClose: () => {}, onRun: () => {} }),
		);
		assert.ok(failed.includes("An extraction is running.") && failed.includes("No concept depends on this document alone."));
	});
});
