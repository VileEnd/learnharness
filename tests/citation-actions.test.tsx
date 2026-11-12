/**
 * useCitationActions (components/citation-quote.tsx) must keep ONE identity
 * while the transcript streams: every transcript row is memoised on it, so a
 * fresh object per chunk would re-render the whole transcript. The check it
 * hands out still reads the latest transcript.
 */
import React, { act, createRef } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useCitationActions, type CitationActions } from "../components/citation-quote.tsx";
import { serializeCitation } from "../src/core/citations.ts";
import type { LhViewMessage } from "../src/core/view.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

const assistant = (text: string): LhViewMessage => ({ id: "g1", role: "assistant", parts: [{ type: "text", id: "a1-t0", text }] });
const quote = serializeCitation({ version: 1, chatId: "chat_1", messageId: "a1", text: "streamed words", start: 0, end: 14, prefix: "", suffix: "" });
const parse = (): Parameters<CitationActions["check"]>[0] => {
	const href = quote.slice(quote.indexOf("(") + 1, -1);
	const url = new URL(href);
	return { version: 1, chatId: "chat_1", messageId: "a1", text: url.searchParams.get("text")!, start: 0, end: 14, prefix: "", suffix: "" };
};

it("keeps one identity across message updates, and its check reads the newest transcript", async () => {
	const seen: CitationActions[] = [];
	const scroll = createRef<never>();
	function Probe({ messages }: { messages: LhViewMessage[] }) {
		seen.push(useCitationActions("chat_1", messages, scroll));
		return null;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Probe messages={[assistant("so far")]} />));
	assert.equal(seen[0]!.check(parse()), false, "not said yet");
	await act(async () => root.render(<Probe messages={[assistant("so far, and the streamed words arrive")]} />));
	await act(async () => root.render(<Probe messages={[assistant("so far, and the streamed words arrive, more")]} />));
	assert.ok(seen.length >= 3);
	assert.ok(seen.every((actions) => actions === seen[0]), "one identity for every render");
	assert.equal(seen[0]!.check(parse()), true, "reads the latest transcript");
	await act(async () => root.unmount());
});
