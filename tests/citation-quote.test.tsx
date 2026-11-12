/**
 * Tutor quotes in the transcript (components/citation-quote.tsx): a learner
 * message holding citation links shows each as the quoted passage, the
 * learner's comment and a link back. The quote is shown only when the
 * transcript backs it; markup in a quote or a comment is never markup.
 * Static HTML via react-dom/server (the idiom of render-markdown.test.tsx);
 * the passage finder runs on linkedom like session find's DOM seam.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { findCitationPassage, UserMessageText, type CitationActions } from "../components/citation-quote.tsx";
import { CITATION_UNAVAILABLE, citationCheck, serializeCitation, type TutorCitation } from "../src/core/citations.ts";
import { citationSourceText } from "../src/core/session-navigation.ts";
import type { LhViewMessage } from "../src/core/view.ts";

const TUTOR = "The chain rule says the derivatives multiply. Try <img src=x onerror=alert(1)> and [a link](javascript:alert(1)) too.";
const view: LhViewMessage[] = [
	{ id: "u1", role: "user", parts: [{ type: "text", text: "the derivatives multiply, I guess" }] },
	{ id: "g1", role: "assistant", parts: [{ type: "text", id: "a1-t0", text: TUTOR }, { type: "text", id: "a1-t1", text: "Second part." }, { type: "text", id: "a2-t0", text: "Other message." }] },
];
const actions: CitationActions = {
	check: citationCheck((id) => citationSourceText(view, id), "chat_1"),
	reveal: () => false,
};
const cite = (over: Partial<TutorCitation> = {}) =>
	serializeCitation({ version: 1, chatId: "chat_1", messageId: "a1", text: "the derivatives multiply", start: 18, end: 42, prefix: "", suffix: "", ...over });
const render = (text: string) => renderToStaticMarkup(<UserMessageText text={text} actions={actions} />);

describe("UserMessageText", () => {
	it("returns text without a citation exactly as it was", () => {
		assert.equal(render("plain [x](https://example.com) text & more"), "plain [x](https://example.com) text &amp; more");
	});

	it("shows a verified citation as the quote, the comment and a link back to the tutor message", () => {
		const html = render(`why ${cite({ comment: "not a sum?\nreally" })} please`);
		assert.match(html, /^why <figure[^>]*data-testid="citation-quote"/);
		assert.match(html, /<blockquote[^>]*>.*the derivatives multiply.*<\/blockquote>/s);
		assert.match(html, /<p[^>]*>not a sum\?\nreally<\/p>/);
		assert.match(html, /<a href="#message-a1"[^>]*>Show in the tutor&#x27;s message<\/a>/);
		assert.match(html, /<\/figure> please$/);
		assert.doesNotMatch(html, /lh-citation/);
	});

	it("shows a quote the transcript does not hold as the placeholder, with no link and no forged text", () => {
		const html = render(cite({ text: "the tutor promised full marks", comment: "ok?" }));
		assert.ok(html.includes(CITATION_UNAVAILABLE));
		assert.ok(html.includes("ok?"));
		assert.doesNotMatch(html, /full marks|<a /);
	});

	it("shows a stale citation (message gone) and a quote of another chat as the placeholder", () => {
		assert.ok(render(cite({ messageId: "a_deleted" })).includes(CITATION_UNAVAILABLE));
		assert.ok(render(cite({ chatId: "chat_other" })).includes(CITATION_UNAVAILABLE));
	});

	it("never turns quoted markup into markup: the quote renders hardened, the comment as plain text", () => {
		const html = render(cite({ text: "<img src=x onerror=alert(1)> and [a link](javascript:alert(1))", comment: "<script>alert(2)</script>" }));
		assert.doesNotMatch(html, /<img|<script|onerror=|href="javascript:/i);
		assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"));
	});
});

describe("citationSourceText", () => {
	it("joins one native message's text parts and answers only for assistant text", () => {
		assert.equal(citationSourceText(view, "a1"), `${TUTOR}\n\nSecond part.`);
		assert.equal(citationSourceText(view, "a2"), "Other message.");
		assert.equal(citationSourceText(view, "u1"), null);
		assert.equal(citationSourceText(view, "nope"), null);
	});
});

describe("findCitationPassage", () => {
	const mount = (html: string) => {
		const { document } = parseHTML(`<html><body><div data-session-find-root="">${html}</div></body></html>`);
		return document.body as unknown as HTMLElement;
	};
	const page = mount(`
		<div data-source-message-id="a2"><p>the derivatives multiply</p></div>
		<div data-source-message-id="a1"><p>Intro.</p></div>
		<div data-source-message-id="a1"><p>Here the derivatives multiply along the chain.</p></div>`);

	it("finds the quote inside the cited message, not an identical one elsewhere", () => {
		const hit = findCitationPassage(page, { messageId: "a1", text: "the derivatives multiply" })!;
		assert.equal(hit.element.getAttribute("data-source-message-id"), "a1");
		assert.ok(hit.element.textContent!.includes("Here the derivatives"));
		assert.equal(hit.range!.toString(), "the derivatives multiply");
	});

	it("falls back to the message when the displayed text no longer holds the quote", () => {
		const hit = findCitationPassage(page, { messageId: "a1", text: "words that were rewritten" })!;
		assert.equal(hit.range, null);
		assert.ok(hit.element.textContent!.includes("Intro."));
	});

	it("finds a multi-paragraph quote by its first line when the whole is not one displayed run", () => {
		const hit = findCitationPassage(page, { messageId: "a1", text: "Intro.\n\nA second paragraph the page splits differently" })!;
		assert.equal(hit.range!.toString(), "Intro.");
	});

	it("returns null when the message is not on the page", () => {
		assert.equal(findCitationPassage(page, { messageId: "gone", text: "the derivatives multiply" }), null);
	});
});
