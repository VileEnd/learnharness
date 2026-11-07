import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageView } from "../components/settings/usage-section.tsx";
import { UsersSectionView, type UsersSectionViewProps } from "../components/settings/users-section.tsx";
import { formatHitRate } from "../components/usage-format.ts";
import type { CategoryTotal, RequestLogLine, UsageCategory, UsageMonthView } from "../src/core/index.ts";
import { categoryCacheHitRate, monthCacheHitRate, summarizeMonth } from "../src/core/usage.ts";

const line = (o: Partial<RequestLogLine>): RequestLogLine => ({
	v: 1, provider: "p", model: "m", outcome: "ok", at: "2026-10-05T10:00:00Z",
	purpose: "teacher", category: "teaching", ...o,
});
const price = () => null;

test("category hit rate folds reads over prompt tokens, and stays absent without data", () => {
	const { categories } = summarizeMonth("2026-10", [
		line({ input: 100, cacheRead: 600, cacheWrite: 300 }),
		line({ input: 0, cacheRead: 100 }),
		line({ category: "graph", purpose: "extractor", input: 500 }), // no reads
		line({ category: "library", purpose: "ocr" }), // no tokens at all
		line({ category: "jobs", purpose: "researcher", cacheRead: 50 }), // no input: no prompt size
	], price);
	assert.equal(categoryCacheHitRate(categories.teaching), 700 / 1100);
	assert.equal(categoryCacheHitRate(categories.graph), null);
	assert.equal(categoryCacheHitRate(categories.library), null);
	assert.equal(categoryCacheHitRate(categories.jobs), null);
	assert.equal(monthCacheHitRate(categories), 700 / 1600);
	assert.equal(monthCacheHitRate(summarizeMonth("2026-10", [], price).categories), null);
});

test("absent hit rate renders as a dash, never 0%", () => {
	assert.equal(formatHitRate(null), "—");
	assert.equal(formatHitRate(undefined), "—");
	assert.equal(formatHitRate(0.9), "90.0%");
});

const zero = (): CategoryTotal => ({ usd: null, calls: 0, tokens: 0, unpriced: 0, cacheReadTokens: 0, promptTokens: 0 });
const view = (teaching: Partial<CategoryTotal>): UsageMonthView => ({
	month: "2026-10", totalUsd: 1, calls: 5, unpricedCalls: 0, failures: 0,
	categories: {
		...(Object.fromEntries((["teaching", "practice", "canvas-reader", "graph", "jobs", "library", "learner", "search"] as UsageCategory[]).map((c) => [c, zero()])) as Record<UsageCategory, CategoryTotal>),
		teaching: { ...zero(), usd: 1, calls: 3, tokens: 1000, ...teaching },
		graph: { ...zero(), usd: 0, calls: 2, tokens: 500, promptTokens: 500 },
	},
	days: [], sessions: [],
});
const renderUsage = (v: UsageMonthView) => renderToStaticMarkup(
	<UsageView months={[]} month="2026-10" view={v} failures={null} page={0} onMonth={() => {}} onPage={() => {}} />,
);

test("Settings → Usage shows a hit rate per category, a dash when absent", () => {
	const html = renderUsage(view({ cacheReadTokens: 900, promptTokens: 1000 }));
	assert.match(html, /data-testid="usage-cache-teaching"[^>]*>90\.0%</);
	assert.match(html, /data-testid="usage-cache-graph"[^>]*>—</);
});

test("admin users list shows each user's hit rate only when there is data", () => {
	const users = [
		{ id: "id-a", username: "ann", email: null, isAdmin: false, enabled: true, createdAt: null },
		{ id: "id-b", username: "bob", email: null, isAdmin: false, enabled: true, createdAt: null },
	];
	const usage = [
		{ userId: "id-a", spentUsd: 1, unpricedCalls: 0, capUsd: 5, restricted: true, cacheHitRate: 0.5 },
		{ userId: "id-b", spentUsd: 1, unpricedCalls: 0, capUsd: 5, restricted: true, cacheHitRate: null },
	];
	const props = {
		users, devices: [], selfName: "ann", error: null, expandedId: null, tempPassword: null, newDevice: null,
		loginUrl: "https://app.example.test/", now: 0, busy: false, onToggle() {}, onCreateUser() {}, onSetAdmin() {},
		onAddDevice() {}, onRevoke() {}, onDismissPassword() {}, onDismissDevice() {}, policy: null, usage, catalog: [],
		saveError: null, onSaveDefaults() {}, onSaveUserPolicy() {}, onUseDefaults() {},
	} as unknown as UsersSectionViewProps;
	const html = renderToStaticMarkup(<UsersSectionView {...props} />);
	assert.match(html, /data-testid="user-cache-id-a"[^>]*>cache hit 50\.0%</);
	assert.doesNotMatch(html, /user-cache-id-b/);
});
