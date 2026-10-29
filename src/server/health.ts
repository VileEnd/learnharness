/**
 * Health probe (multi-user PR1): 200 when the data dir is usable, 503 with
 * the exact fix while a pre-multi-user layout still sits at the data root.
 * Never tenant-scoped — it only looks at DATA_ROOT.
 */
import { legacyLayoutPresent } from "../../config.ts";

export const LEGACY_FIX = "node scripts/migrate-to-tenants.mjs --owner <keycloak-sub>";

export function healthStatus(): { status: number; body: { ok: true } | { error: "legacy_layout"; fix: string } } {
	if (legacyLayoutPresent()) return { status: 503, body: { error: "legacy_layout", fix: LEGACY_FIX } };
	return { status: 200, body: { ok: true } };
}
