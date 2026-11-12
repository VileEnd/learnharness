/**
 * StatementText (components/statement-text.tsx): the plain text shows first,
 * in the surface's own type, until the Markdown renderer has loaded on demand.
 * The first test must stay first: a loaded React.lazy stays loaded for the rest
 * of the process, and every test file runs in its own process.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatementText } from "../components/statement-text.tsx";
import { mountSettled, rendered } from "./mount-rendered.tsx";

describe("StatementText", () => {
	it("shows the source text in the surface's type before the renderer has loaded", () => {
		const html = renderToStaticMarkup(<StatementText>{"Plain $x$ text"}</StatementText>);
		assert.ok(html.includes("Plain $x$ text"));
		assert.ok(html.includes("text-xs leading-relaxed") && !html.includes("katex"));
		assert.ok(renderToStaticMarkup(<StatementText type="name">Name</StatementText>).includes("text-sm font-medium leading-snug"));
	});

	it("then renders it, keeping layout classes, and loads once the renderer is there", async () => {
		const { host, unmount } = await mountSettled(<StatementText className="mt-1 flex-1">{"Value $x^2$"}</StatementText>, rendered);
		try {
			assert.equal(host.querySelectorAll(".katex").length, 1);
			const block = host.querySelector(".lh-prose")!;
			assert.ok(block.classList.contains("mt-1") && block.classList.contains("flex-1"));
		} finally { await unmount(); }
	});
});
