/**
 * Settings → Usage (cost counter, 2026-10-29): the hand-made SVG charts and
 * the read-only section, rendered with stubbed data (effects never fire
 * under renderToStaticMarkup, so the section's pure view takes the data).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DailyBars, MonthBars } from "../components/usage/charts.tsx";
import { UsageView } from "../components/settings/usage-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { CategoryTotal, RequestLogLine, UsageCategory, UsageMonthView } from "../src/core/index.ts";

/** Each day's bar group, by its data-day attribute. */
function dayGroups(html: string): string[] {
	return html.split("<g data-day=").slice(1).map((g) => g.slice(0, g.indexOf("</g>")));
}

describe("DailyBars", () => {
	it("draws one bar group per calendar day of October, and a 2-category day as 2 segments", () => {
		const html = renderToStaticMarkup(
			<DailyBars month="2026-10" days={[{ day: "2026-10-05", byCategory: { teaching: 0.3, graph: 0.12 } }]} />,
		);
		const groups = dayGroups(html);
		assert.equal(groups.length, 31);
		const oct5 = groups.find((g) => g.startsWith('"2026-10-05"'));
		assert.ok(oct5);
		assert.equal(oct5.match(/<rect/g)?.length, 2);
		assert.equal(groups.filter((g) => g.includes("<rect")).length, 1, "empty days are drawn empty");
		assert.ok(oct5.includes("<title>"), "a tooltip per bar");
	});
});

/** Each month slot, by its data-month attribute. */
function monthGroups(html: string): string[] {
	return html.split("<g data-month=").slice(1).map((g) => g.slice(0, g.indexOf("</g>")));
}

describe("MonthBars", () => {
	it("draws one bar per priced month", () => {
		const html = renderToStaticMarkup(
			<MonthBars
				months={[
					{ month: "2026-08", totalUsd: 1.2, unpricedCalls: 0 },
					{ month: "2026-09", totalUsd: null, unpricedCalls: 3 },
					{ month: "2026-10", totalUsd: 4.5, unpricedCalls: 1 },
				]}
			/>,
		);
		assert.equal(html.match(/<rect/g)?.length, 2, "Aug and Oct; Sep is unpriced");
	});

	it("lays twelve contiguous calendar months: a month without a log is an empty \"no requests\" slot", () => {
		const html = renderToStaticMarkup(
			<MonthBars
				months={[
					{ month: "2026-01", totalUsd: 1, unpricedCalls: 0 },
					{ month: "2026-03", totalUsd: 2, unpricedCalls: 0 },
				]}
			/>,
		);
		const groups = monthGroups(html);
		assert.equal(groups.length, 12);
		assert.ok(groups[0]?.startsWith('"2025-04"') && groups[11]?.startsWith('"2026-03"'));
		const feb = groups.find((g) => g.startsWith('"2026-02"'));
		assert.ok(feb?.includes("no requests") && !feb.includes("<rect"));
	});
});

const empty = (): CategoryTotal => ({ usd: null, calls: 0, tokens: 0, unpriced: 0 });
const categories = Object.fromEntries(
	(["teaching", "practice", "canvas-reader", "graph", "jobs", "library", "learner", "search"] as UsageCategory[]).map((c) => [c, empty()]),
) as Record<UsageCategory, CategoryTotal>;

const view: UsageMonthView = {
	month: "2026-10",
	totalUsd: 0.42,
	calls: 3,
	unpricedCalls: 0,
	failures: 1,
	categories: { ...categories, teaching: { usd: 0.42, calls: 3, tokens: 12000, unpriced: 0 } },
	days: [{ day: "2026-10-05", byCategory: { teaching: 0.42 } }],
	sessions: [{ chatId: "c1", usd: 0.42, calls: 3, title: "Fourier series", kind: "teach" }],
};

const failure: RequestLogLine = {
	v: 1,
	at: "2026-10-05T10:00:00.000Z",
	purpose: "teacher",
	category: "teaching",
	chatId: "c1",
	provider: "openrouter",
	model: "z-ai/glm-5.3-flash",
	outcome: "error",
	error: "429 rate limited by upstream",
};

describe("UsageView (the section, stubbed)", () => {
	it("lists a failed request with its error text and a link to its chat", () => {
		const html = renderToStaticMarkup(
			<UsageView
				months={[{ month: "2026-10", totalUsd: 0.42, unpricedCalls: 0 }]}
				month="2026-10"
				view={view}
				failures={{ lines: [failure], total: 1, pageSize: 50 }}
				page={0}
				onMonth={() => {}}
				onPage={() => {}}
			/>,
		);
		assert.ok(html.includes("429 rate limited by upstream"));
		assert.ok(html.includes('href="/chat/c1"'));
	});

	it("a failed failures page leaves the month and its charts standing", () => {
		const html = renderToStaticMarkup(
			<UsageView
				months={[{ month: "2026-10", totalUsd: 0.42, unpricedCalls: 0 }]}
				month="2026-10"
				view={view}
				failures="error"
				page={0}
				onMonth={() => {}}
				onPage={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="usage-daily-chart"'));
		assert.ok(html.includes('data-testid="usage-month-chart"'));
		assert.ok(html.includes("Failed requests could not be loaded."));
	});

	it("an empty month says so", () => {
		const html = renderToStaticMarkup(
			<UsageView
				months={[]}
				month="2026-10"
				view={{ ...view, totalUsd: null, calls: 0, failures: 0, categories, days: [], sessions: [] }}
				failures={{ lines: [], total: 0, pageSize: 50 }}
				page={0}
				onMonth={() => {}}
				onPage={() => {}}
			/>,
		);
		assert.ok(html.includes("No requests logged this month."));
	});
});

describe("Settings nav", () => {
	it("has a Usage section", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.match(html, /data-testid="settings-nav-usage"[^>]*>Usage</);
	});
});
