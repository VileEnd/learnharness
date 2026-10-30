import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
	CustomEndpointEditor,
	CustomEndpointSection,
	customErrorMessage,
	hasUsableProvider,
	pinsPayload,
	type CustomStatus,
} from "../components/settings/custom-endpoint.tsx";
import { setupStage, SetupKeysBody } from "../components/setup-dialog.tsx";
import { zeroKeys } from "../components/setup-cta.tsx";
import { isVisionPickable } from "../components/settings/model-menu.tsx";
import { UsersSectionView, type UsersSectionViewProps } from "../components/settings/users-section.tsx";
import type { ModelCatalogEntry, UserPolicy } from "../src/core/index.ts";

const noop = () => {};
const status = (over: Partial<NonNullable<CustomStatus["config"]>> | null = {}): CustomStatus => ({
	configured: true,
	usable: true,
	keyPresent: false,
	keyBound: false,
	config: over === null ? null : {
		baseUrl: "http://192.0.2.10:11434/v1",
		mode: "keyless",
		pricing: "free",
		snapshot: [{ id: "qwen3:8b" }, { id: "m2" }],
		...over,
	},
});
const editor = (s: CustomStatus) =>
	renderToStaticMarkup(<CustomEndpointEditor status={s} etag='"e1"' onChanged={noop} onReload={noop} />);

describe("custom endpoint editor", () => {
	it("hides the key input in keyless mode and shows a password field in key mode", () => {
		assert.doesNotMatch(editor(status()), /custom-key-input/);
		const html = editor(status({ mode: "key" }));
		assert.match(html, /data-testid="custom-key-input"[^>]*type="password"|type="password"[^>]*data-testid="custom-key-input"/);
	});

	it("keeps the saved key on a blank field and says so", () => {
		const html = renderToStaticMarkup(
			<CustomEndpointEditor status={{ ...status({ mode: "key" }), keyBound: true }} etag="x" onChanged={noop} onReload={noop} />,
		);
		assert.match(html, /Leave blank to keep the saved key/);
	});

	it("shows rate fields only in paid mode", () => {
		const free = editor(status({ pricing: "free" }));
		assert.doesNotMatch(free, /custom-rate-in-/);
		assert.doesNotMatch(free, /custom-unpriced-/);
		const paid = editor(status({ pricing: "paid" }));
		assert.match(paid, /data-testid="custom-rate-in-qwen3:8b"/);
		assert.match(paid, /data-testid="custom-rate-out-m2"/);
	});

	it("flags a paid model without rates and clears the hint once both rates exist", () => {
		const html = editor(status({ pricing: "paid", models: { m2: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } } }));
		assert.match(html, /data-testid="custom-unpriced-qwen3:8b"/);
		assert.match(html, /set rates to offer this to users with a spending limit/);
		assert.doesNotMatch(html, /data-testid="custom-unpriced-m2"/);
	});

	it("renders pins and the approved reasoning labels, with help below the models", () => {
		const html = editor(status({ models: { m2: { context: 32000, reasoning: false } } }));
		assert.match(html, /value="32000"/);
		assert.match(html, /Reasoning effort: Use reported/);
		assert.match(html, /Reasoning effort: Not supported/);
		assert.ok(html.indexOf("custom-help") > html.indexOf("custom-pins-save"));
		assert.match(html, /Disconnect/);
		assert.doesNotMatch(editor(status(null)), /Disconnect|custom-pins/);
	});

	it("flags a damaged config and disables Connect", () => {
		const html = renderToStaticMarkup(
			<CustomEndpointEditor status={{ configured: false, corrupt: true, config: null }} etag="" onChanged={noop} onReload={noop} />,
		);
		assert.match(html, /custom-corrupt/);
		assert.match(html, /data-testid="custom-save"[^>]*disabled/);
	});
});

describe("custom endpoint helpers", () => {
	it("pinsPayload validates numbers, enforces both-or-neither rates, and drops empty entries", () => {
		const d = (over = {}) => ({ context: "", maxOutput: "", reasoning: "" as const, inRate: "", outRate: "", ...over });
		assert.deepEqual(pinsPayload({ a: d(), b: d({ context: "32000", reasoning: "off", inRate: "1.5", outRate: "0" }) }), {
			ok: true,
			models: { b: { context: 32000, reasoning: false, inputUsdPerMTok: 1.5, outputUsdPerMTok: 0 } },
		});
		assert.equal(pinsPayload({ a: d({ inRate: "1" }) }).ok, false);
		assert.equal(pinsPayload({ a: d({ context: "1.5" }) }).ok, false);
		assert.equal(pinsPayload({ a: d({ maxOutput: "0" }) }).ok, false);
		assert.equal(pinsPayload({ a: d({ inRate: "-1", outRate: "1" }) }).ok, false);
		assert.equal(pinsPayload({ a: d({ inRate: "x", outRate: "1" }) }).ok, false);
	});

	it("has readable copy for every documented error code", () => {
		for (const code of [
			"admin_only", "same_origin_required", "json_required", "body_too_large", "invalid_base_url", "invalid_mode",
			"invalid_pricing", "invalid_key", "key_required", "invalid_models", "invalid_patch", "stale", "not_configured",
			"probe_failed", "custom_provider_corrupt", "auth_unavailable", "save_failed",
		]) assert.doesNotMatch(customErrorMessage(code), /Something went wrong/, code);
		assert.match(customErrorMessage("probe_failed", "Endpoint returned HTTP 404."), /HTTP 404/);
		assert.match(customErrorMessage("weird"), /\(weird\)/);
	});
});

// ---- the section: admin gate, stale handling (linkedom + client render) ----
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = host = undefined;
	globalThis.fetch = originalFetch;
});
async function mount(isAdmin: boolean) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<CustomEndpointSection isAdmin={isAdmin} />));
}
const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function click(id: string) {
	const node = el(id);
	assert.ok(node, id);
	await act(async () => node.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
}

describe("custom endpoint section", () => {
	it("a non-admin gets no row, no editor and no request", async () => {
		let calls = 0;
		globalThis.fetch = async () => { calls++; return Response.json({}); };
		await mount(false);
		assert.equal(el("custom-endpoint-row"), null);
		assert.equal(el("custom-endpoint-editor"), null);
		assert.equal(calls, 0);
	});

	it("an admin sees the row; a stale save shows inline copy and Reload and retry re-reads", async () => {
		const methods: string[] = [];
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			const m = init?.method ?? "GET";
			methods.push(m);
			if (m === "GET") return Response.json(status(), { headers: { etag: `"e${methods.length}"` } });
			assert.equal((init!.headers as Record<string, string>)["if-match"], '"e1"');
			return Response.json({ error: "stale" }, { status: 409 });
		}) as typeof fetch;
		await mount(true);
		assert.match(el("custom-endpoint-status")!.textContent ?? "", /192\.0\.2\.10:11434 · 2 models/);
		await click("custom-endpoint-row-btn");
		await click("custom-save");
		assert.match(el("custom-error")!.textContent ?? "", /changed somewhere else/);
		await click("custom-reload");
		assert.deepEqual(methods, ["GET", "POST", "GET"]);
		assert.equal(el("custom-error"), null, "the remount after reload clears the error");
	});

	it("a failed load says so and offers Retry; a non-admin-shaped answer shows no editor", async () => {
		globalThis.fetch = (async () => Response.json({ configured: true })) as typeof fetch;
		await mount(true);
		assert.ok(el("custom-load-error"));
		assert.match(el("custom-endpoint-status")!.textContent ?? "", /unavailable/);
	});
});

// ---- users editor ----
const entry = (provider: string, id: string, cost: ModelCatalogEntry["cost"]): ModelCatalogEntry => ({
	provider, id, name: id, reasoning: false, input: ["text"], supportedLevels: [], cost, contextWindow: 1000, maxTokens: 100,
});
const catalog = [
	entry("anthropic", "model-x", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
	entry("custom", "free-one", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
	entry("custom", "paid-norates", null),
];
const baseUsers = (policy: UserPolicy): UsersSectionViewProps => ({
	users: [{ id: "id-bob", username: "bob", email: null, isAdmin: false, enabled: true, createdAt: null }],
	devices: [], selfName: "alice", error: null, expandedId: null, tempPassword: null, newDevice: null,
	loginUrl: "https://app.example.test/", now: 0, busy: false, onToggle: noop, onCreateUser: noop, onSetAdmin: noop,
	onAddDevice: noop, onRevoke: noop, onDismissPassword: noop, onDismissDevice: noop,
	policy: { defaults: policy, users: {} }, usage: [], catalog, saveError: null, onSaveDefaults: noop, onSaveUserPolicy: noop,
});
const renderUsers = (policy: UserPolicy) => renderToStaticMarkup(<UsersSectionView {...baseUsers(policy)} />);

describe("users editor and custom models", () => {
	const none: UserPolicy = { slots: {}, allowedModels: [], monthlyCapUsd: null };
	it("lists custom models and marks the unpriced one", () => {
		const html = renderUsers(none);
		assert.match(html, /free-one \(custom\)/);
		assert.match(html, /paid-norates \(custom\) — no rates/);
		assert.match(html, /set rates to offer this to users with a spending limit/);
		assert.doesNotMatch(html, /free-one \(custom\) — no rates/);
	});
	it("with no limit the unpriced model is selectable", () => {
		const html = renderUsers(none);
		assert.doesNotMatch(html, /<option value="custom:paid-norates" disabled/);
		assert.doesNotMatch(html, /type="checkbox"[^>]*disabled/);
	});
	it("with a limit the unpriced model cannot be picked, the priced one can", () => {
		const html = renderUsers({ ...none, monthlyCapUsd: 5 });
		assert.match(html, /<option value="custom:paid-norates" disabled/);
		assert.doesNotMatch(html, /<option value="custom:free-one" disabled/);
		assert.match(html, /<input type="checkbox"[^>]*disabled=""[^>]*\/?>[^<]*paid-norates/);
	});
	it("a capped policy that already holds an unpriced model is blocked with a message", () => {
		const html = renderUsers({ slots: { strong: { provider: "custom", id: "paid-norates" } }, allowedModels: [], monthlyCapUsd: 5 });
		assert.match(html, /defaults-unpriced-blocked/);
		assert.match(html, /<button[^>]*disabled=""[^>]*>Save defaults/);
	});
});

describe("setup surfaces", () => {
	const customRow = { id: "custom", keyPresent: true };
	it("the custom row alone does not finish setup when the user has no custom model", () => {
		assert.equal(hasUsableProvider([customRow], []), false);
		assert.equal(hasUsableProvider([customRow], [{ provider: "custom" }]), true);
		assert.equal(hasUsableProvider([customRow, { id: "anthropic", keyPresent: true }], []), true);
		assert.equal(hasUsableProvider([customRow]), true, "no model list: rows at face value");
		assert.equal(setupStage([customRow], []), "keys");
		assert.equal(setupStage([customRow], [{ provider: "custom" }]), "pickers");
		assert.equal(zeroKeys({ providers: [customRow] as never, models: [] }), true);
		assert.equal(zeroKeys({ providers: [customRow] as never, models: [entry("custom", "a", null)] }), false);
	});
	const keysBody = (admin: boolean | null) =>
		renderToStaticMarkup(
			<SetupKeysBody providers={[]} provider={null} value="" saving={false} error={null} menuOpen={false}
				onToggleMenu={noop} onPick={noop} onValue={noop} onSave={noop} menuAnchor={{ current: null }} admin={admin} />,
		);
	it("a non-admin is told to ask their admin; an admin is pointed at Settings; unknown shows neither", () => {
		assert.match(keysBody(false), /Ask your administrator/);
		assert.doesNotMatch(keysBody(false), /setup-custom-admin-hint/);
		assert.match(keysBody(true), /setup-custom-admin-hint/);
		assert.doesNotMatch(keysBody(null), /setup-custom-/);
	});
	it("the vision slot keeps every custom model selectable", () => {
		assert.equal(isVisionPickable(entry("custom", "text-only", null)), true);
		assert.equal(isVisionPickable(entry("anthropic", "model-x", null)), false);
		assert.equal(isVisionPickable({ ...entry("anthropic", "v", null), input: ["text", "image"] }), true);
	});
});
