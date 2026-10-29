/**
 * Settings → Users (admin-only): the pure view rendered with stubbed
 * props (effects and fetches never run under renderToStaticMarkup).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsersSectionView, errorMessage, type UsersSectionViewProps } from "../components/settings/users-section.tsx";

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

describe("errorMessage", () => {
	it("maps known codes and falls back generically", () => {
		assert.match(errorMessage("wireguard_peers_corrupt"), /nothing was changed/);
		assert.equal(errorMessage("wireguard_full"), "No free WireGuard addresses left.");
		assert.equal(errorMessage("username_taken"), "That username is already taken.");
		assert.equal(errorMessage("email_taken"), "That email is already used by another account.");
		assert.equal(errorMessage("weird"), "Something went wrong (weird)");
	});
});
