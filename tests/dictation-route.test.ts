import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";

// Isolated data dir BEFORE any app-module import (config.ts reads LH_DATA_DIR once).
const testData = mkdtempSync(path.join(tmpdir(), "lh-dictation-settings-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

it("the section route persists language independently, clears it with {}, and rejects unsupported values without writing", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1, general: { autoUpdate: false } });
	const putBody = (body: unknown) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "dictation" }) });
	assert.equal((await putBody({ language: "pl" })).status, 200);
	const saved = { version: 1, dictation: { language: "pl" }, general: { autoUpdate: false } };
	assert.deepEqual(readSettings(), saved);
	assert.equal((await putBody({ language: "unsupported" })).status, 400);
	assert.deepEqual(readSettings(), saved);
	const general = await PUT(new Request("http://localhost/api/settings/general", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoUpdate: true }),
	}), { params: Promise.resolve({ section: "general" }) });
	assert.equal(general.status, 200);
	assert.deepEqual(readSettings(), { ...saved, general: { autoUpdate: true } }, "auto-update cannot erase dictation language");
	assert.equal((await putBody({})).status, 200);
	assert.equal(readSettings()?.dictation?.language, undefined, "{} returns to the default");
});

