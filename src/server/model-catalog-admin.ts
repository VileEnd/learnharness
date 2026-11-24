/**
 * The model-catalog refresh's routes, as logic (the routes stay transport):
 * POST /api/models (refresh now) and GET/PUT /api/admin/model-catalog (the
 * daily-refresh switch). The callers check requireAdmin().
 */

import { AdminPolicyCorrupt } from "../core/contracts/admin.ts";
import type { ModelCatalogAdminView, ModelCatalogRefreshResponse } from "../core/contracts/models.ts";
import { modelCatalog } from "./model-catalog.ts";
import { modelCatalogAutoRefresh, setModelCatalogAutoRefresh } from "./policy.ts";
import { modelCatalogCheckedAt, refreshModelCatalog } from "./remote-model-catalog.ts";

const headers = { "Cache-Control": "no-store" };

/** POST /api/models → {outcome, catalog}; 502 when pi.dev or a row fails
 *  (nothing is published, the current catalog stays). */
export async function modelCatalogRefreshPost(): Promise<Response> {
	let outcome;
	try {
		outcome = await refreshModelCatalog();
	} catch (err) {
		console.warn(`[model-catalog] refresh failed: ${err instanceof Error ? err.message : err}`);
		return Response.json({ error: "model_catalog_refresh_failed" }, { status: 502, headers });
	}
	return Response.json({ outcome, catalog: modelCatalog() } satisfies ModelCatalogRefreshResponse, { headers });
}

/** GET /api/admin/model-catalog → {autoRefresh, checkedAt}. */
export function modelCatalogAdminView(): Response {
	return Response.json({ autoRefresh: modelCatalogAutoRefresh(), checkedAt: modelCatalogCheckedAt() } satisfies ModelCatalogAdminView, { headers });
}

/** PUT {autoRefresh: boolean} → the view. 400 on any other body; 500
 *  admin_policy_corrupt on a corrupt admin.json (never overwritten). */
export function modelCatalogAdminPut(raw: unknown): Response {
	const v = raw && typeof raw === "object" ? (raw as { autoRefresh?: unknown }).autoRefresh : undefined;
	if (typeof v !== "boolean") return Response.json({ error: "autoRefresh must be true or false" }, { status: 400 });
	try {
		setModelCatalogAutoRefresh(v);
	} catch (e) {
		if (e instanceof AdminPolicyCorrupt) return Response.json({ error: "admin_policy_corrupt" }, { status: 500 });
		throw e;
	}
	return modelCatalogAdminView();
}
