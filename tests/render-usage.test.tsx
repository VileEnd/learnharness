/**
 * The monthly cost pill and its breakdown panel on home (cost counter,
 * 2026-10-29), rendered with stubbed data (effects never fire under
 * renderToStaticMarkup, so the panel is a pure view of a UsageMonthView).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageMonthControl, UsageMonthPanel } from "../components/usage/month-pill.tsx";
import type { CategoryTotal, UsageCategory, UsageMonthView } from "../src/core/index.ts";

const ZERO: CategoryTotal = { usd: null, calls: 0, tokens: 0, unpriced: 0 };

function view(over: Partial<UsageMonthView> = {}): UsageMonthView {
	const categories = Object.fromEntries(
		(["teaching", "practice", "canvas-reader", "graph", "jobs", "library", "learner", "search"] as UsageCategory[]).map((c) => [c, { ...ZERO }]),
	) as Record<UsageCategory, CategoryTotal>;
	categories.teaching = { usd: 0.3, calls: 12, tokens: 1000, unpriced: 0 };
	categories.graph = { usd: 0.12, calls: 4, tokens: 500, unpriced: 0 };
	return {
		month: "2026-10",
		totalUsd: 0.42,
		calls: 16,
		unpricedCalls: 0,
		failures: 0,
		categories,
		days: [],
		sessions: [
			{ chatId: "A", usd: 0.3, calls: 12, title: "Money multiplier", kind: "teach" },
			{ chatId: "B", usd: null, calls: 4, title: "Gone", kind: "deleted" },
		],
		...over,
	};
}

describe("UsageMonthControl (the pill)", () => {
	it("shows this month's total", () => {
		assert.match(renderToStaticMarkup(<UsageMonthControl usage={view()} />), />This month \$0\.42</);
	});
	it("shows a dash for an unpriced total and while loading", () => {
		assert.match(renderToStaticMarkup(<UsageMonthControl usage={view({ totalUsd: null })} />), />This month —</);
		assert.match(renderToStaticMarkup(<UsageMonthControl usage={null} />), />This month —</);
	});
});

describe("UsageMonthPanel", () => {
	it("lists the categories that have calls, with their calls", () => {
		const html = renderToStaticMarkup(<UsageMonthPanel usage={view()} />);
		assert.match(html, /Teaching/);
		assert.match(html, /Graph/);
		assert.match(html, /12 calls/);
		assert.doesNotMatch(html, /Practice/);
	});
	it("says how many calls are unpriced", () => {
		assert.match(renderToStaticMarkup(<UsageMonthPanel usage={view({ unpricedCalls: 2 })} />), /2 calls unpriced/);
		assert.match(renderToStaticMarkup(<UsageMonthPanel usage={view({ unpricedCalls: 1 })} />), /1 call unpriced/);
		assert.doesNotMatch(renderToStaticMarkup(<UsageMonthPanel usage={view()} />), /unpriced/);
	});
	it("links the top sessions to their chats, and a deleted one is plain text", () => {
		const html = renderToStaticMarkup(<UsageMonthPanel usage={view()} />);
		assert.match(html, /2 sessions with spend/);
		assert.match(html, /href="\/chat\/A"/);
		assert.doesNotMatch(html, /href="\/chat\/B"/);
		assert.match(html, /Gone/);
	});
	it("pluralises failed requests", () => {
		assert.match(renderToStaticMarkup(<UsageMonthPanel usage={view({ failures: 1 })} />), /1 failed request(?!s)/);
		assert.match(renderToStaticMarkup(<UsageMonthPanel usage={view({ failures: 3 })} />), /3 failed requests/);
	});
	it("has a Details link", () => {
		assert.match(renderToStaticMarkup(<UsageMonthPanel usage={view()} />), />Details</);
	});
});
