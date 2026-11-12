/**
 * Server-side persistence for THE user settings record (settings-storage
 * wave, 2026-09-19): data/settings.json (config.settingsFile()), under the
 * LH_DATA_DIR seam — read-modify-write, NOT a ledger. Non-secret product
 * preferences only; secrets stay in auth.json / .env.local.
 *
 * This adapter OWNS the lazy migrations:
 *  1. schema-version bumps (CURRENT_SETTINGS_VERSION) slot in here; pure
 *     additions never bump, so an up-to-date file is always a no-op
 *     pass-through. v1 → v2 (themes): see migrateSettingsV1.
 *    (The legacy default-settings.json fold died with the chat section —
 *     per-session models, owner 2026-09-28.)
 *
 * Everything off disk is sanitized (core/settings.ts) before it reaches a
 * caller; everything written was already validated by the routes
 * (settings-body.ts) and is sanitized here again — the file can never hold
 * a value that would silently shift a knob.
 */

import fs from "node:fs";
import path from "node:path";
import { settingsFile } from "../../config.ts";
import {
	CURRENT_SETTINGS_VERSION,
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import { shiftHex } from "../core/themes.ts";
import type { SettingsStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** The persisted record, or null when none exists (first boot). Runs the
 *  migration chain on every read — cheap: a no-op file check when current. */
export function readSettings(): UserSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(settingsFile(), "utf-8");
	} catch {
		return null; // no settings.json yet — first boot, all factory defaults
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null; // corrupt → first-boot semantics (all factory defaults)
	}
	const record = sanitizeUserSettings(parsed);
	if (!record) return null;
	// Version chain. Lazy: the migrated shape lands on disk with the next
	// section write. Unknown NEWER versions pass through untouched (the
	// sanitizer preserved unknowns).
	// An unstamped file is v1 (lazy v1: absence reads as the first shape).
	const stamped = (parsed as { version?: unknown }).version;
	return stamped === 1 || stamped === undefined ? migrateSettingsV1(record) : record;
}

/**
 * v1 → v2 (themes, 2026-11-12). In v1 a custom `appearance.background`
 * derived the whole dark palette from itself (components/settings/
 * appearance.tsx derivedPalette: surfaces +8 per channel, hover +22, edges
 * +47). In v2 `background` overrides the background only, so the derived
 * surface and border become explicit overrides (the hover follows the
 * surface, +14, which lands on the same +22): nobody's colours change. The
 * never-enabled `mode` key was already dropped by the sanitizer. Pure.
 */
export function migrateSettingsV1(record: UserSettings): UserSettings {
	const out: UserSettings = { ...record, version: CURRENT_SETTINGS_VERSION };
	const background = record.appearance?.background;
	if (record.appearance && typeof background === "string") {
		out.appearance = {
			...record.appearance,
			colors: { surface: shiftHex(background, 8), border: shiftHex(background, 47), ...record.appearance.colors },
		};
	}
	return out;
}

/** Persist the record (sanitized). Returns what was written. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
	writeFileAtomicSync(settingsFile(), JSON.stringify(settings, null, "\t"));
	return settings;
}

/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
