import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocumentReaderBody } from "../components/document-reader.tsx";
import type { DocumentSummary } from "../src/core/index.ts";

const meta = { id: "doc_aaaaaaaaaaaa", title: "Mutex basics", filenames: [], topics: [], importedAt: "2026-10-01T10:00:00.000Z", pages: 3 } as unknown as DocumentSummary;

describe("Document reader pages", () => {
	it("lets the browser skip off-screen pages of a multi-page document", () => {
		const markdown = "<!-- page 1 -->\nOne\n<!-- page 2 -->\nTwo\n<!-- page 3 -->\nThree";
		const html = renderToStaticMarkup(createElement(DocumentReaderBody, { meta, markdown }));
		const sections = html.match(/<section [^>]*>/g) ?? [];
		assert.equal(sections.length, 3);
		for (const tag of sections) {
			assert.match(tag, /content-visibility:auto/);
			assert.match(tag, /contain-intrinsic-size:auto_/);
		}
	});

	it("leaves a single-page document alone", () => {
		const html = renderToStaticMarkup(createElement(DocumentReaderBody, { meta, markdown: "# Just text" }));
		assert.ok(!html.includes("content-visibility"));
	});
});
