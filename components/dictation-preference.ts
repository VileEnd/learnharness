"use client";

import { useSyncExternalStore } from "react";
import { isDictationLanguage, sanitizeUserSettings, type DictationLanguage, type UserSettings } from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

/** The picker's value: a Nova-3 code, or "default" = no `language` param
 *  (Deepgram's default). Stored as an absent language. */
export type DictationChoice = DictationLanguage | "default";

const INITIAL = { choice: undefined as DictationChoice | undefined, saving: false, error: null as string | null };

const toChoice = (language: DictationLanguage | undefined): DictationChoice => language ?? "default";
const toLanguage = (choice: DictationChoice): DictationLanguage | undefined => choice === "default" ? undefined : choice;

/** One confirmed preference and one write in flight, shared by every surface.
 * The factory keeps transport tests isolated without a second persistence path.
 */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<DictationChoice> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	function load(refresh = false): Promise<DictationChoice> {
		if (writing) return confirmed();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.choice !== undefined) return Promise.resolve(snapshot.choice);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return confirmed();
				const choice = toChoice(record?.dictation?.language);
				needsRead = false;
				publish({ choice, error: null });
				return choice;
			} catch {
				if (version !== revision) return confirmed();
				const message = "Could not load dictation language. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	function save(choice: DictationChoice): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.choice === undefined) return Promise.resolve(false);
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const language = toLanguage(choice);
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(language === undefined ? {} : { language }),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const stored = body.settings?.dictation?.language;
				if (stored !== undefined && !isDictationLanguage(stored)) throw new Error();
				needsRead = false;
				publish({ choice: toChoice(stored), error: null });
				saved();
				return true;
			} catch {
				publish({ error: "Could not save dictation language. Try again." });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	async function confirmed(): Promise<DictationChoice> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.choice === undefined) await load();
			else return snapshot.choice;
		}
	}

	/** The language to send to Deepgram: undefined = send no param. */
	async function getLanguage(): Promise<DictationLanguage | undefined> {
		return toLanguage(await confirmed());
	}

	/** For starting a run: never rejects. A failed read falls back to the last
	 *  confirmed choice, else undefined (the Deepgram default). The error stays
	 *  published on the snapshot for the picker. */
	async function getLanguageForCapture(): Promise<DictationLanguage | undefined> {
		try {
			return await getLanguage();
		} catch {
			return snapshot.choice === undefined ? undefined : toLanguage(snapshot.choice);
		}
	}

	/** Test seam: back to a never-confirmed store. */
	function reset() {
		snapshot = INITIAL; reading = null; writing = null; revision++; needsRead = true;
	}

	return {
		reset, load, save, getLanguage, getLanguageForCapture,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

/** Test seam: the store lives for the window, so tests reset it between cases. */
export function resetDictationLanguageStoreForTests() { store.reset(); }

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, getLanguage: store.getLanguage, getLanguageForCapture: store.getLanguageForCapture };
}
