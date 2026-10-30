import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DICTATION_LANGUAGES, deepgramListenUrl, isDictationLanguage } from "../src/core/dictation.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { DICTATION_KEYLESS, createCanManageKeysCache, dictationErrorLabel, loadCanManageKeys } from "../components/dictation.tsx";

describe("Nova-3 dictation language contract", () => {
	it("offers monolingual languages/locales and a distinct multilingual mode", () => {
		assert.equal(DICTATION_LANGUAGES[0]?.code, "multi");
		assert.equal(new Set(DICTATION_LANGUAGES.map((item) => item.code)).size, DICTATION_LANGUAGES.length);
		for (const code of ["en", "fr", "ru", "sv", "pl", "en-GB", "pt-BR", "zh-Hant", "ar-EG", "multi"]) {
			assert.ok(isDictationLanguage(code), code);
		}
		// Xhosa and Zulu are documented for multi, not monolingual Nova-3.
		for (const code of ["xh", "zu", "en-CA", "auto", "xx", "pl&model=other", null, 3]) {
			assert.equal(isDictationLanguage(code), false, String(code));
		}
		const labels = DICTATION_LANGUAGES.slice(1).map((item) => item.label);
		assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, "en")));
	});

	it("only language varies in the streaming URL; all tuned parameters survive", () => {
		for (const { code: language } of DICTATION_LANGUAGES) {
			const url = new URL(deepgramListenUrl(language));
			assert.equal(url.origin + url.pathname, "wss://api.deepgram.com/v1/listen");
			assert.deepEqual(Object.fromEntries(url.searchParams), {
				model: "nova-3", encoding: "linear16", sample_rate: "16000", channels: "1",
				smart_format: "true", punctuate: "true", endpointing: "300", language,
			});
		}
	});

	it("(a) no language set sends no language param", () => {
		const url = new URL(deepgramListenUrl());
		assert.equal(url.searchParams.has("language"), false);
		assert.equal(url.searchParams.get("model"), "nova-3");
		assert.equal(url.searchParams.get("endpointing"), "300");
		assert.equal(new URL(deepgramListenUrl(undefined)).searchParams.has("language"), false);
		// A value outside the allowed list never reaches the URL.
		assert.equal(deepgramListenUrl("x&model=evil" as never).includes("evil"), false);
	});

	it("(a) a set language is URL-encoded in the param", () => {
		assert.ok(deepgramListenUrl("pt-BR").endsWith("&language=pt-BR"));
		assert.equal(new URL(deepgramListenUrl("zh-Hant")).searchParams.get("language"), "zh-Hant");
	});

	it("old records resolve with no language; explicit preferences resolve without a migration", () => {
		assert.deepEqual(resolveSettings(null).dictation, {});
		assert.deepEqual(resolveSettings({ version: 1 }).dictation, {});
		for (const language of ["pl", "multi", "en-GB"] as const) {
			const record = sanitizeUserSettings({ version: 1, dictation: { language } });
			assert.equal(record?.version, 1);
			assert.equal(resolveSettings(record).dictation.language, language);
		}
	});

	it("rejects invalid API values and drops invalid stored preferences", () => {
		assert.deepEqual(parseDictationSettingsBody({}), { ok: true, settings: {} });
		assert.deepEqual(parseDictationSettingsBody({ language: "multi" }), { ok: true, settings: { language: "multi" } });
		for (const value of [null, [], "pl", { language: "xx" }, { language: null }, { language: 3 }]) {
			assert.equal(parseDictationSettingsBody(value).ok, false);
		}
		for (const dictation of [null, [], "pl", { language: "xx" }, { language: 3 }]) {
			const record = sanitizeUserSettings({ version: 1, dictation, general: { autoUpdate: false } });
			assert.equal(resolveSettings(record).dictation.language, undefined);
			assert.equal(record?.general?.autoUpdate, false);
		}
	});
});

describe("(d) the missing Deepgram key copy", () => {
	it("a signed-in non-admin is told an admin adds the key", () => {
		assert.match(dictationErrorLabel(DICTATION_KEYLESS, false), /admin/i);
		assert.ok(dictationErrorLabel(DICTATION_KEYLESS, false).startsWith(DICTATION_KEYLESS));
	});
	it("an admin or the single-user owner keep the plain line; an unknown (still loading) account gets the admin copy", () => {
		assert.equal(dictationErrorLabel(DICTATION_KEYLESS, true), DICTATION_KEYLESS);
		assert.match(dictationErrorLabel(DICTATION_KEYLESS, null), /admin/i);
	});
	it("other errors are never rewritten", () => {
		assert.equal(dictationErrorLabel("mic unavailable", false), "mic unavailable");
	});
});

describe("admin detection from /api/me fails closed", () => {
	const reply = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
	it("no account (single-user owner) can manage keys; an admin can; a non-admin cannot", async () => {
		assert.equal(await loadCanManageKeys(reply({ account: null })), true);
		assert.equal(await loadCanManageKeys(reply({ account: { name: "a", isAdmin: true } })), true);
		assert.equal(await loadCanManageKeys(reply({ account: { name: "a", isAdmin: false } })), false);
	});
	it("a non-ok response, a rejected fetch and malformed bodies are non-admin", async () => {
		assert.equal(await loadCanManageKeys(reply({}, 500)), false);
		assert.equal(await loadCanManageKeys((async () => { throw new Error("offline"); }) as unknown as typeof fetch), false);
		for (const body of [{}, null, [], "x", { account: "x" }, { account: [] }, { account: {} }]) {
			assert.equal(await loadCanManageKeys(reply(body)), false, JSON.stringify(body));
		}
	});
	it("a failed fetch is not cached: the next call retries and sees admin", async () => {
		let calls = 0;
		const flaky = (async () => {
			if (calls++ === 0) throw new TypeError("Failed to fetch");
			return Response.json({ account: { name: "a", isAdmin: true } });
		}) as unknown as typeof fetch;
		const get = createCanManageKeysCache(flaky);
		assert.equal(await get(), false);
		assert.equal(await get(), true);
		assert.equal(await get(), true);
		assert.equal(calls, 2, "the success is cached");
	});
	it("the non-admin outcome yields the admin copy", async () => {
		const can = await loadCanManageKeys(reply({}, 500));
		assert.match(dictationErrorLabel(DICTATION_KEYLESS, can), /admin/i);
	});
});
