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
import { StatementText, createStatementText } from "../components/statement-text.tsx";
import { mountSettled, rendered } from "./mount-rendered.tsx";

describe("StatementText", () => {
	it("before the renderer has loaded: markup-free text shows as it is, text that may hold markup is hidden, never shown raw", () => {
		const plain = renderToStaticMarkup(<StatementText>{"A plain sentence, nothing special."}</StatementText>);
		assert.ok(plain.includes("A plain sentence") && plain.includes("text-xs leading-relaxed"));
		assert.ok(!plain.includes("invisible"));
		for (const source of ["Plain $x$ text", "uses `code`", "a **bold** word", "- item", "1. item", "a [link](https://example.com)", "x < y"]) {
			const html = renderToStaticMarkup(<StatementText>{source}</StatementText>);
			assert.ok(html.includes("invisible"), `${source}: hidden (space reserved) until rendered`);
			assert.ok(!html.includes("katex"));
		}
		assert.ok(renderToStaticMarkup(<StatementText type="name">Name</StatementText>).includes("text-sm font-medium leading-snug"));
	});

	it("then renders it, keeping layout classes", async () => {
		const { host, unmount } = await mountSettled(<StatementText className="mt-1 flex-1">{"Value $x^2$"}</StatementText>, rendered);
		try {
			assert.equal(host.querySelectorAll(".katex").length, 1);
			const block = host.querySelector(".lh-prose")!;
			assert.ok(block.classList.contains("mt-1") && block.classList.contains("flex-1"));
		} finally { await unmount(); }
	});
});

describe("StatementText once the renderer is preloaded", () => {
	it("renders the Markdown in its first commit: no placeholder phase, no Suspense reveal delay", async () => {
		const { StatementText: Preloaded, preload } = createStatementText(() => import("../components/statement-text-rendered.tsx"));
		assert.ok(!renderToStaticMarkup(<Preloaded>{"$x$"}</Preloaded>).includes("katex"), "not loaded yet: placeholder");
		preload();
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.ok(renderToStaticMarkup(<Preloaded>{"$x$"}</Preloaded>).includes('class="katex"'), "a static render, which runs no effects, already shows the formula");
	});
});

describe("StatementText when the renderer chunk cannot load", () => {
	it("leaves the plain text visible and throws nothing; a later open retries and renders", async () => {
		let calls = 0;
		const { StatementText: Flaky } = createStatementText(async () => {
			if (++calls === 1) throw new Error("Loading chunk failed (a deploy removed it)");
			return import("../components/statement-text-rendered.tsx");
		});
		const failed = await mountSettled(<Flaky>{"Value $x^2$"}</Flaky>, (h) => h.querySelector("div") !== null && h.querySelector(".invisible") === null);
		try {
			assert.equal(failed.host.textContent, "Value $x^2$", "the plain source text, visible");
			assert.equal(failed.host.querySelectorAll(".katex").length, 0);
		} finally { await failed.unmount(); }
		assert.equal(calls, 1);
		const retried = await mountSettled(<Flaky>{"Value $x^2$"}</Flaky>, rendered);
		try {
			assert.equal(calls, 2, "the next open asked for the chunk again");
			assert.equal(retried.host.querySelectorAll(".katex").length, 1);
		} finally { await retried.unmount(); }
	});
});
