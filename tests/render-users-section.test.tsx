/**
 * Settings → Users (admin-only): the pure view rendered with stubbed
 * props (effects and fetches never run under renderToStaticMarkup).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsersSectionView, errorMessage, policyCatalog, toPolicy, type UsersSectionViewProps } from "../components/settings/users-section.tsx";
import type { ModelCatalogEntry, UserPolicy } from "../src/core/index.ts";

const NOW = 1_800_000_000_000;
const noop = () => {};
const users = [
	{ id: "id-alice", username: "alice", email: "alice@example.test", isAdmin: true, enabled: true, createdAt: null },
	{ id: "id-bob", username: "bob", email: null, isAdmin: false, enabled: true, createdAt: null },
];
const devices = [
	{ id: "d1", userId: "id-bob", name: "phone", ip: "10.0.0.2", createdAt: "2026-10-29T00:00:00.000Z", latestHandshake: null, stale: true },
	{ id: "d2", userId: "id-bob", name: "laptop", ip: "10.0.0.3", createdAt: "2026-10-29T00:00:00.000Z", latestHandshake: NOW / 1000 - 7200, stale: false },
];

const entry = (provider: string, id: string, name: string): ModelCatalogEntry => ({
	provider, id, name, reasoning: false, input: ["text"], supportedLevels: [],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
});
const catalog = [
	entry("openrouter", "xiaomi/mimo-v2.6-flash", "Mimo Flash"),
	entry("anthropic", "claude-sonnet-5-5", "Sonnet Five"),
	entry("anthropic", "model-x", "Model X"),
];
const defaults: UserPolicy = {
	slots: { strong: { provider: "anthropic", id: "claude-sonnet-5-5" }, cheap: { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" } },
	allowedModels: ["anthropic:model-x"],
	monthlyCapUsd: 7.5,
};
const custom: UserPolicy = { slots: {}, allowedModels: [], monthlyCapUsd: 2 };
const usage = [
	{ userId: "id-alice", spentUsd: 0, unpricedCalls: 0, capUsd: null, restricted: false },
	{ userId: "id-bob", spentUsd: 3.5, unpricedCalls: 2, capUsd: 3, restricted: true },
];

function render(over: Partial<UsersSectionViewProps> = {}): string {
	return renderToStaticMarkup(
		<UsersSectionView
			users={users}
			devices={devices}
			selfName="alice"
			error={null}
			expandedId="id-bob"
			tempPassword={null}
			newDevice={null}
			loginUrl="https://app.example.test/"
			now={NOW}
			busy={false}
			onToggle={noop}
			onCreateUser={noop}
			onSetAdmin={noop}
			onAddDevice={noop}
			onRevoke={noop}
			onDismissPassword={noop}
			onDismissDevice={noop}
			policy={{ defaults, users: { "id-bob": custom } }}
			usage={usage}
			catalog={catalog}
			saveError={null}
			onSaveDefaults={noop}
			onSaveUserPolicy={noop}
			{...over}
		/>,
	);
}

describe("UsersSectionView", () => {
	it("lists users with admin badge, device count, device rows and a disabled self-demotion", () => {
		const html = render();
		assert.match(html, /alice/);
		assert.match(html, /data-testid="user-admin-badge-id-alice"/);
		assert.doesNotMatch(html, /data-testid="user-admin-badge-id-bob"/);
		assert.match(html, /outdated — re-create/);
		assert.match(html, /never/);
		assert.match(html, /2h ago/);
		assert.match(html, /10\.0\.0\.2/);
		const own = render({ expandedId: "id-alice" });
		assert.match(own, /data-testid="user-admin-toggle-id-alice"[^>]*disabled=""/);
		assert.match(html, /data-testid="user-admin-toggle-id-bob"(?![^>]*disabled="")/);
	});

	it("shows the temporary password panel once", () => {
		const html = render({ tempPassword: { username: "bob", password: "pw-123" } });
		assert.match(html, /Temporary password for bob/);
		assert.match(html, /pw-123/);
		assert.match(html, /This password is not shown again\./);
		assert.match(html, /https:\/\/app\.example\.test\//);
	});

	it("shows the device panel with the QR and a named download link", () => {
		const html = render({
			newDevice: { username: "bob", name: "my phone!", config: "[Interface]\n", qrSvg: "<svg id=\"qr\"></svg>" },
		});
		assert.match(html, /<svg id="qr">/);
		assert.match(html, /download="bob-my_phone_\.conf"/);
		assert.match(html, /private key is not stored/);
	});

	it("renders configuration errors inline", () => {
		assert.match(render({ error: "user_admin_not_configured" }), /User management isn&#x27;t set up on this server yet\./);
		assert.match(render({ error: "wireguard_not_ready" }), /WireGuard isn&#x27;t set up on this server yet\./);
	});
});

describe("UsersSectionView models and limits", () => {
	it("renders the defaults box with slot values, cap and the Recommended hint", () => {
		const html = render();
		assert.match(html, /New user defaults/);
		assert.match(html, /<option value="anthropic:claude-sonnet-5-5" selected="">/);
		assert.match(html, /<option value="openrouter:xiaomi\/mimo-v2\.6-flash" selected="">[^<]*Recommended/);
		assert.match(html, /Monthly limit \(\$\)/);
		assert.match(html, /value="7\.5"/);
		assert.match(html, /Also allowed/);
	});

	it("shows spend, cap, unpriced calls and a limit reached badge", () => {
		const html = render();
		assert.match(html, /\$3\.50 this month of \$3\.00/);
		assert.match(html, /\+2 unpriced calls/);
		assert.match(html, /limit reached/);
		assert.doesNotMatch(render({ usage: [{ userId: "id-bob", spentUsd: 1, unpricedCalls: 0, capUsd: 3, restricted: true }] }), /limit reached|unpriced/);
		assert.match(render({ usage: [{ userId: "id-bob", spentUsd: 1, unpricedCalls: 0, capUsd: null, restricted: true }] }), /no limit/);
	});

	it("keeps absent spend absent and flags unreadable usage", () => {
		const html = render({ usage: [{ userId: "id-bob", spentUsd: null, unpricedCalls: null, capUsd: null, restricted: true, error: "usage_unreadable" }] });
		assert.match(html, /— this month/);
		assert.match(html, /Usage unavailable/);
	});

	it("admin row says unrestricted and has no editor", () => {
		const html = render({ expandedId: "id-alice" });
		assert.match(html, /admin — unrestricted/);
		assert.doesNotMatch(html, /data-testid="policy-editor-id-alice"/);
	});

	it("non-admin has a Models & limit editor with a Use defaults toggle", () => {
		const html = render();
		assert.match(html, /Models &amp; limit/);
		assert.match(html, /data-testid="policy-editor-id-bob"/);
		assert.match(html, /value="2"/);
	});

	it("Use defaults checked hides the per-user fields", () => {
		const html = render({ policy: { defaults, users: {} } });
		const editor = html.slice(html.indexOf('data-testid="policy-editor-id-bob"'));
		assert.match(editor, /Use defaults/);
		assert.match(editor, /<input[^>]*checked=""[^>]*\/>\s*Use defaults/);
		assert.doesNotMatch(editor, /Monthly limit/);
	});

	it("renders a policy save error", () => {
		assert.match(render({ saveError: "slot model not allowed" }), /Couldn&#x27;t save: slot model not allowed/);
	});
});

describe("UsersSectionView without usage rows", () => {
	it("keeps the editor for a non-admin and says no usage yet; admin stays unrestricted", () => {
		const bob = render({ usage: [] });
		assert.match(bob, /no usage yet/);
		assert.match(bob, /data-testid="policy-editor-id-bob"/);
		const alice = render({ usage: [], expandedId: "id-alice" });
		assert.match(alice, /admin — unrestricted/);
		assert.doesNotMatch(alice, /data-testid="policy-editor-id-alice"/);
	});

	it("shows a save failure next to the editor that failed", () => {
		const html = render({ saveError: "bad cap", saveErrorFor: "id-bob" });
		assert.match(html, /data-testid="user-id-bob-save-error"/);
		assert.doesNotMatch(html, /data-testid="defaults-save-error"/);
		assert.match(render({ saveError: "bad cap", saveErrorFor: "defaults" }), /data-testid="defaults-save-error"/);
	});
});

describe("toPolicy", () => {
	const m = { provider: "p", id: "a" };
	it("maps an empty cap to null and dedupes allowed models", () => {
		const pol = toPolicy({ strong: m }, ["p:a", "p:b", "p:a"], "  ");
		assert.deepEqual(pol, { slots: { strong: m }, allowedModels: ["p:a", "p:b"], monthlyCapUsd: null });
	});
	it("omits unset slot keys and parses the cap", () => {
		const pol = toPolicy({ strong: m, vision: undefined }, [], "2.5");
		assert.ok(pol && !("vision" in pol.slots) && !("cheap" in pol.slots));
		assert.equal(pol.monthlyCapUsd, 2.5);
	});
	it("returns null for an invalid cap", () => {
		assert.equal(toPolicy({}, [], "abc"), null);
		assert.equal(toPolicy({}, [], "-1"), null);
	});
});

describe("errorMessage", () => {
	it("maps known codes and falls back generically", () => {
		assert.match(errorMessage("wireguard_peers_corrupt"), /nothing was changed/);
		assert.equal(errorMessage("wireguard_full"), "No free WireGuard addresses left.");
		assert.equal(errorMessage("username_taken"), "That username is already taken.");
		assert.equal(errorMessage("email_taken"), "That email is already used by another account.");
		assert.equal(errorMessage("weird"), "Something went wrong (weird)");
	});
});

describe("policyCatalog", () => {
	it("drops Claude Code models from the per-user pickers", () => {
		const models = [entry("openrouter", "a", "A"), entry("claude-code", "sonnet", "Sonnet")];
		assert.deepEqual(policyCatalog(models).map((m) => m.provider), ["openrouter"]);
	});
});
