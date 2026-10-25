/**
 * The document search UI, statically (PR I): the library's text-search
 * results (title, heading path, page, snippet, links to the reader's page
 * anchor, the honest mode label), the transcript cards for the three document
 * tools, and the settings toggle's composer.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentsLibraryBody, hitHref } from "../components/documents-library.tsx";
import { DocumentCard, documentSummary } from "../components/artifacts/document-card.tsx";
import { composeDocumentTools } from "../components/settings/agent-section.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import type { DocSearchResult } from "../src/core/index.ts";

const result: DocSearchResult = {
	mode: "keyword",
	query: "lock",
	note: "Keyword search only: no OpenRouter key is set, so documents are not embedded.",
	hits: [
		{ docId: "doc_aaaaaaaaaaaa", title: "Blatt 7", sectionId: "s2", headingPath: ["Mutex", "Aufgabe 3"], pageFrom: 2, pageTo: 3, snippet: "Warum braucht lock() ein unlock()?", score: 0.03 },
		{ docId: "doc_bbbbbbbbbbbb", title: "Notizen", sectionId: "s1", headingPath: [], snippet: "ohne Seiten", score: 0.02 },
	],
};

describe("library text search", () => {
	const html = renderToStaticMarkup(
		createElement(DocumentsLibraryBody, { documents: [], query: "lock", onQuery: () => {}, onAdd: () => {}, search: { state: "done", result } }),
	);

	it("lists hits with title, heading path, pages and snippet, linking to the page anchor", () => {
		assert.ok(html.includes('href="/documents/doc_aaaaaaaaaaaa#p-2"'));
		assert.ok(html.includes("Mutex › Aufgabe 3 · pp. 2-3"));
		assert.ok(html.includes("Warum braucht lock() ein unlock()?"));
		assert.ok(html.includes('href="/documents/doc_bbbbbbbbbbbb"'), "no page, no anchor");
		assert.equal(hitHref("doc_x", undefined), "/documents/doc_x");
	});

	it("says honestly which mode answered, and why it is weaker", () => {
		assert.ok(html.includes('data-mode="keyword"') && html.includes("· keyword"));
		assert.ok(html.includes("no OpenRouter key is set"));
		const hybrid = renderToStaticMarkup(createElement(DocumentsLibraryBody, { documents: [], query: "x", onQuery: () => {}, onAdd: () => {}, search: { state: "done", result: { ...result, mode: "hybrid", note: undefined } } }));
		assert.ok(hybrid.includes("keyword + semantic"));
	});

	it("wraps long text instead of overflowing the phone width", () => {
		const results = html.slice(html.indexOf('data-testid="search-results"'));
		assert.ok(results.includes("break-words") && !results.includes("whitespace-nowrap"));
	});
});

describe("document tool cards", () => {
	const card = (tool: string, input: unknown, output: unknown) =>
		renderToStaticMarkup(createElement(DocumentCard, { part: { type: `tool-${tool}`, state: "output-available", toolCallId: "c", input, output } as never }));

	it("search: 'Searched documents: <query> · N hits' with links to the hits' pages", () => {
		const details = { kind: "search", query: "lock", mode: "keyword", hits: result.hits };
		const html = card("search_documents", { query: "lock" }, details);
		assert.ok(html.includes("Searched documents: lock · 2 hits"));
		assert.ok(html.includes('href="/documents/doc_aaaaaaaaaaaa#p-2"'));
		assert.equal(documentSummary("search_documents", {}, { ...details, hits: [result.hits[0]!] } as never), "Searched documents: lock · 1 hit");
	});

	it("read: 'Read <title> § … p.N' and 'pages 3-4', linking to the reader", () => {
		const section = { kind: "read", ok: true, docId: "doc_aaaaaaaaaaaa", title: "Blatt 7", label: "§ Mutex > Aufgabe 3", sectionId: "s2", pageFrom: 2, pageTo: 2 };
		assert.equal(documentSummary("read_document", {}, section as never), "Read Blatt 7 § Mutex > Aufgabe 3 p.2");
		assert.ok(card("read_document", {}, section).includes('href="/documents/doc_aaaaaaaaaaaa#p-2"'));
		assert.equal(documentSummary("read_document", {}, { ...section, label: "pages 3-4", pageFrom: 3, pageTo: 4 } as never), "Read Blatt 7 pages 3-4");
		assert.equal(documentSummary("read_document", { document: "x" }, { kind: "read", ok: false, error: "nope" }), "Could not read x");
	});

	it("list, a running call, and the registry", () => {
		assert.equal(documentSummary("list_documents", {}, { kind: "list", count: 3 }), "Listed documents · 3");
		const running = renderToStaticMarkup(createElement(DocumentCard, { part: { type: "tool-search_documents", state: "input-available", toolCallId: "c", input: { query: "lock" } } as never }));
		assert.ok(running.includes("Searching documents: lock") && running.includes("running…"));
		for (const name of ["search_documents", "read_document", "list_documents"]) assert.equal(artifactRenderers[name], DocumentCard);
	});
});

describe("settings", () => {
	it("composeDocumentTools writes the agent.documentTools key and keeps the rest", () => {
		assert.deepEqual(composeDocumentTools({ graphTools: { enabled: false } }, false), { graphTools: { enabled: false }, documentTools: { enabled: false } });
		assert.deepEqual(composeDocumentTools(undefined, true), { documentTools: { enabled: true } });
	});
});
