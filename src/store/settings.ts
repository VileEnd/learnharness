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
	isHexColor,
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
	// Version chain, on the raw JSON before the sanitizer (which knows only
	// the current shape). Lazy: the migrated shape lands on disk with the
	// next section write. Unknown NEWER versions pass through untouched (the
	// sanitizer preserves unknowns). An unstamped file is v1 (lazy v1:
	// absence reads as the first shape).
	const stamped = parsed !== null && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
	return sanitizeUserSettings(stamped === 1 || stamped === undefined ? migrateSettingsV1(parsed) : parsed);
}

const isHex = (v: unknown): v is string => typeof v === "string" && isHexColor(v);
const asObject = (v: unknown): Record<string, unknown> | undefined =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * v1 → v2 (themes, 2026-11-12), on the raw record. v1 had one set of colour
 * knobs, all chosen against the dark page: `appearance.background` (which
 * derived the whole palette from itself: components/settings/appearance.tsx
 * derivedPalette, surfaces +8 per channel, hover +22, edges +47) and
 * `mdRendering.boldColor/italicColor`. v2 stores overrides per theme, and
 * these move into DEFAULT's only (owner ruling: a dark background must not
 * follow the learner onto Ivory): background, surface (+8) and border (+47)
 * (the hover follows the surface, +14, landing on the same +22), bold and
 * italic. Nobody's Default colours change; Ivory starts clean. The
 * never-enabled `mode` key is dropped. Pure; non-objects pass through.
 */
export function migrateSettingsV1(raw: unknown): unknown {
	const record = asObject(raw);
	if (!record) return raw;
	const out: Record<string, unknown> = { ...record, version: CURRENT_SETTINGS_VERSION };
	const appearance = asObject(record.appearance);
	if (!appearance) return out;
	const { background, mode: _mode, mdRendering, ...rest } = appearance;
	const md = asObject(mdRendering);
	const { boldColor, italicColor, ...mdRest } = md ?? {};
	const own: Record<string, string> = {};
	if (isHex(background)) {
		own.background = background;
		own.surface = shiftHex(background, 8);
		own.border = shiftHex(background, 47);
	}
	if (isHex(boldColor)) own.bold = boldColor;
	if (isHex(italicColor)) own.italic = italicColor;
	const next: Record<string, unknown> = { ...rest };
	if (md) next.mdRendering = mdRest;
	if (Object.keys(own).length) next.colors = { default: own };
	out.appearance = next;
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
