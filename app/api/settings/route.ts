/**
 * GET /api/settings — THE user settings record (settings-storage wave,
 * 2026-09-19): the whole delta record at data/settings.json (config.
 * settingsFile(), via the SettingsStore port). Non-secret by construction —
 * secrets live in auth.json / .env.local and never enter this record.
 *
 *   GET → 200 {settings, configured} (the sanitized delta record — absent keys mean
 *         "factory default", never guessed server-side) or 200
 *         {settings: null} on first boot.
 *
 * Section writes go through PUT /api/settings/[section]; the chat defaults
 * also remain writable via the legacy /api/settings/defaults alias.
 * Resolution to concrete values is the client's/core's job
 * (core/settings-resolution.ts resolveSettings — browser-safe).
 */

import { modelsConfigured, readSettingsRecord, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(async () => {
	// The read view: a restricted user's policy overlays the model slots.
	// `configured` (additive): the first-run gate's truth, which for a
	// restricted user asks only for the slots their policy defines.
	return Response.json({ settings: readSettingsRecord(), configured: modelsConfigured() });
});
