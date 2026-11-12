/**
 * The graph home's three states (audit remediation): loading, failed with a
 * retry, and truly empty must read differently — a failed or slow load was
 * shown as "Start a session or add documents to build your graph".
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphPlaceholder, loadGraphSnapshot } from "../components/graph-view.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const EMPTY_COPY = "Start a session or add documents to build your graph";

describe("GraphPlaceholder", () => {
	it("loading shows neither the empty copy nor a retry", () => {
		const html = renderToStaticMarkup(createElement(GraphPlaceholder, { state: "loading", onRetry: () => {} }));
		assert.ok(html.includes("Loading"));
		assert.ok(!html.includes(EMPTY_COPY));
		assert.ok(!html.includes('data-testid="graph-retry"'));
	});

	it("failed shows the failure and a retry control, not the empty copy", () => {
		const html = renderToStaticMarkup(createElement(GraphPlaceholder, { state: "failed", onRetry: () => {} }));
		assert.ok(html.includes("could not be loaded"));
		assert.ok(html.includes('data-testid="graph-retry"'));
		assert.ok(!html.includes(EMPTY_COPY));
	});

	it("empty keeps the first-action copy", () => {
		const html = renderToStaticMarkup(createElement(GraphPlaceholder, { state: "empty", onRetry: () => {} }));
		assert.ok(html.includes(EMPTY_COPY));
		assert.ok(!html.includes('data-testid="graph-retry"'));
	});
});

describe("loadGraphSnapshot", () => {
	it("rejects a non-OK response instead of returning its body as a snapshot", async () => {
		globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
		await assert.rejects(loadGraphSnapshot("source"), /500/);
	});

	it("returns the parsed snapshot on 200", async () => {
		globalThis.fetch = (async () => Response.json({ nodes: [] })) as typeof fetch;
		assert.deepEqual(await loadGraphSnapshot("source"), { nodes: [] });
	});
});
