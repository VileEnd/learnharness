import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphCanvas, GraphChromeRow } from "../components/graph-view.tsx";
import { Conversation, ConversationScrollButton } from "../components/ai-elements/conversation.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";

describe("accessible names of controls that had none", () => {
	it("the graph settings gear is named like its tooltip", () => {
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, {
				isEmpty: false,
				query: "",
				onQuery: () => {},
				noMatch: false,
				searchInputRef: { current: null },
				onAddDocuments: () => {},
				settings: {} as GraphRenderSettings,
				changeSettings: () => {},
				onOpenChains: () => {},
			}),
		);
		const gear = /<button[^>]*aria-expanded[^>]*>/.exec(html)?.[0] ?? "";
		assert.ok(gear.includes('aria-label="Graph display settings"'), gear);
	});

	it("the scroll-to-bottom button is named", () => {
		// initial={false}: the stick-to-bottom state starts scrolled up, so the button renders.
		const html = renderToStaticMarkup(
			<Conversation initial={false}>
				<ConversationScrollButton />
			</Conversation>,
		);
		assert.ok(/<button[^>]*aria-label="Scroll to latest message"/.test(html), html);
	});

	it("the graph canvas has a name and fallback text pointing to the Chains table", () => {
		const html = renderToStaticMarkup(createElement(GraphCanvas, { canvasRef: { current: null } }));
		assert.ok(/<canvas[^>]*role="img"/.test(html), html);
		// role=img hides the children, so the pointer lives in the name itself.
		assert.ok(/<canvas[^>]*aria-label="Knowledge graph[^"]*Chains table/.test(html), html);
		assert.ok(/<canvas[^>]*>[^<]*Chains table[^<]*<\/canvas>/.test(html), "fallback text inside the canvas");
	});
});
