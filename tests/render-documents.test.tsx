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
import { DocumentReaderBody, withoutPageImages } from "../components/document-reader.tsx";
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
