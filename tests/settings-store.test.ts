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
import { DEFAULT_THEME, IVORY_THEME, themeVars } from "../src/core";

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

describe("v1 → v2 (themes): v1's colours move into Default's own overrides", () => {
	const writeRaw = (record: unknown) => {
		fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
		fs.writeFileSync(settingsFile(), JSON.stringify(record), "utf-8");
	};

	it("background → Default's background, surface (+8) and border (+47); emphasis inks too; Default looks as v1 drew it", () => {
		writeRaw({
			version: 1,
			appearance: { background: "#101820", mode: "light", proseFontSize: 18, mdRendering: { headingWeight: 700, boldColor: "#ff8800", italicColor: null } },
		});
		const out = readSettings();
		assert.ok(out);
		assert.equal(out.version, 2);
		assert.deepEqual(out.appearance, {
			proseFontSize: 18,
			mdRendering: { headingWeight: 700 },
			colors: { default: { background: "#101820", surface: "#182028", border: "#3f474f", bold: "#ff8800" } },
		});
		// v1's derivedPalette: surfaces +8 per channel, hover +22, edges +47.
		const vars = themeVars(DEFAULT_THEME, out.appearance);
		assert.equal(vars["--background"], "#101820");
		assert.equal(vars["--card"], "#182028");
		assert.equal(vars["--accent"], "#262e36");
		assert.equal(vars["--border"], "#3f474f");
		assert.equal(vars["--primary-foreground"], "#101820");
		assert.equal(vars["--lh-ink-strong"], "#ff8800");
	});

	it("Ivory starts clean: nothing migrated reaches the light theme", () => {
		writeRaw({ version: 1, appearance: { background: "#101820", mdRendering: { boldColor: "#ff8800" } } });
		const out = readSettings();
		assert.equal(out?.appearance?.colors?.ivory, undefined);
		assert.deepEqual(themeVars(IVORY_THEME, out?.appearance), themeVars(IVORY_THEME));
	});

	it("clamps like v1 did, and an unstamped file reads as v1", () => {
		writeRaw({ appearance: { background: "#f0f0f0" } });
		const out = readSettings();
		assert.equal(out?.version, 2);
		assert.deepEqual(out?.appearance?.colors, { default: { background: "#f0f0f0", surface: "#f8f8f8", border: "#ffffff" } });
	});

	it("no colours: only the stamp moves; a v2 record is never migrated again", () => {
		writeRaw({ version: 1, appearance: { background: null }, graph: { enabled: false } });
		assert.deepEqual(readSettings(), { version: 2, appearance: {}, graph: { enabled: false } });
		writeRaw({ version: 2, appearance: { colors: { default: { background: "#101820" } } } });
		assert.deepEqual(readSettings()?.appearance, { colors: { default: { background: "#101820" } } });
	});
});
