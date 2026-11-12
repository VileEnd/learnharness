/**
 * Tests for the settings STORE (settings-storage wave, 2026-09-19):
 * src/store/settings.ts — the record's fs adapter. Writes under the
 * process's temp data dir (tests/setup.ts); each test starts with no record.
 *
 * (The legacy default-settings.json fold and the chat-section facade died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot server-side.)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { settingsFile } from "../config.ts";
import { readSettings, writeSettings } from "../src/store/settings.ts";

afterEach(() => {
	fs.rmSync(settingsFile(), { force: true });
});

describe("the settings store", () => {
	it("reads null on first boot (no record)", () => {
		fs.rmSync(settingsFile(), { force: true });
		assert.equal(readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});

	it("a chat section on disk is IGNORED — the field died with per-session models (owner, 2026-09-28)", () => {
		fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
		// A fossil `chat` section (the old default-settings record) must not
		// resurrect through the sanitizer — the key is simply gone.
		fs.writeFileSync(
			settingsFile(),
			JSON.stringify({
				version: 1,
				chat: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" },
				graph: { enabled: true },
			}),
			"utf-8",
		);
		const out = readSettings();
		assert.ok(out);
		assert.equal("chat" in out, false, "the chat section never surfaces");
		assert.deepEqual(out.graph, { enabled: true }); // siblings survive
	});

	it("corrupt settings.json → null (first-boot semantics), never throws", () => {
		fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
		fs.writeFileSync(settingsFile(), "{not json", "utf-8");
		assert.equal(readSettings(), null);
	});
});
