import { modelCatalog, modelCatalogRefreshPost, requireAdmin, withTenant } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). GET reads the
 * bundled catalog plus the locally saved pi.dev snapshot: no network.
 */
export const GET = withTenant(async () => {
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
});

/** Refresh the shared catalog from pi.dev now → {outcome, catalog}. Admin
 *  only (403 otherwise); 502 when the refresh fails (nothing published). */
export const POST = withTenant(async () => requireAdmin() ?? modelCatalogRefreshPost());
