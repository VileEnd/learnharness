import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeCodeSection, ClaudeCodeSectionView, claudeCodeStatusLine } from "../components/settings/claude-code-section.tsx";
import { slotCatalogFor } from "../components/settings/agent-section.tsx";
import { ModelMenuList, isSlotPickable } from "../components/settings/model-menu.tsx";
import type { ClaudeCodeStatus, ModelCatalogEntry } from "../src/core/index.ts";

const st = (state: ClaudeCodeStatus["state"], version: string | null = null): ClaudeCodeStatus => ({ state, version, minimumVersion: "2.1.259" });
const view = (status: ClaudeCodeStatus | null, enabled = false) =>
	renderToStaticMarkup(<ClaudeCodeSectionView enabled={enabled} status={status} loaded busy={false} error={null} onToggle={() => {}} />);

describe("Claude Code settings section", () => {
	it("renders each status line", () => {
		assert.match(view(st("meets-minimum", "2.1.301")), /Claude Code 2\.1\.301 ready/);
		assert.match(view(st("not-configured")), /Not set up on this server/);
		assert.match(view(st("not-found")), /The claude container isn&#x27;t running/);
		assert.match(view(st("update-required", "2.1.100")), /Needs an update \(2\.1\.100 &lt; 2\.1\.259\)/);
		assert.match(view(st("version-unchecked")), /Claude Code&#x27;s version couldn&#x27;t be checked/);
		assert.equal(claudeCodeStatusLine(null), "Checking…");
	});
	it("has the toggle and the fixed note", () => {
		const html = view(st("meets-minimum", "2.1.301"), true);
		assert.match(html, /Use Claude Code \(experimental\)/);
		assert.match(html, /aria-checked="true"/);
		assert.match(html, /Runs on the account logged into the claude container\. Only you can use it; usage isn&#x27;t priced\./);
	});
	it("after a failed load shows the error and no Checking line", () => {
		const html = renderToStaticMarkup(<ClaudeCodeSectionView enabled={false} status={null} loaded busy={false} error="Could not load the Claude Code settings." onToggle={() => {}} />);
		assert.match(html, /Could not load the Claude Code settings\./);
		assert.doesNotMatch(html, /Checking…/);
	});
	it("keeps the toggle disabled until the first load has finished", () => {
		const html = (loaded: boolean) => renderToStaticMarkup(<ClaudeCodeSectionView enabled={false} status={null} loaded={loaded} busy={false} error={null} onToggle={() => {}} />);
		assert.match(html(false), /Checking…/);
		assert.match(html(false), /<button[^>]*disabled/);
		assert.doesNotMatch(html(true), /<button[^>]*disabled/);
	});
	it("is absent for a non-admin", () => {
		assert.equal(renderToStaticMarkup(<ClaudeCodeSection isAdmin={false} />), "");
	});
});

describe("claude-code models in pickers", () => {
	const m = (provider: string, id: string, cost: ModelCatalogEntry["cost"]): ModelCatalogEntry => ({
		provider, id, name: id, reasoning: false, input: ["text", "image"], supportedLevels: [], cost, contextWindow: 1000, maxTokens: 100,
	});
	const catalog = [m("openrouter", "x", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }), m("claude-code", "sonnet", null)];
	it("slot pickers drop them, for every slot", () => {
		assert.equal(isSlotPickable(catalog[1]!), false);
		for (const slot of ["strong", "cheap", "vision"] as const) {
			assert.deepEqual(slotCatalogFor(slot, catalog)?.map((e) => e.provider), ["openrouter"]);
		}
	});
	it("the menu shows subscription, never a price", () => {
		const html = renderToStaticMarkup(<ModelMenuList models={[catalog[1]!]} effectiveId={undefined} onPick={() => {}} />);
		assert.match(html, /subscription/);
		assert.doesNotMatch(html, /\$0/);
	});
});
