/**
 * THE FIRST-PAINT THEME (themes step 2): what app/layout.tsx needs to send
 * the first frame in the learner's theme: the record's appearance section,
 * read in THIS request's tenant scope.
 *
 * The root layout is not wrapped in withPageTenant (it also renders the
 * not-found and error shells), so the tenant is resolved here from the
 * forwarded identity header, the same way withPageTenant does. Nothing here
 * may break a page: no identity, the legacy single-user layout or an
 * unreadable record all fall back to the factory appearance (Default).
 *
 * Why this is safe with the service worker: pages (navigations) are
 * network-only in src/server/pwa/sw.js and never cached, and RSC payloads
 * pass it untouched; the only cached shell is the static /offline.html,
 * which carries no per-user state. So one learner's themed HTML never
 * reaches another learner from a cache.
 *
 * React's cache() makes the layout, generateViewport and generateMetadata
 * share one read per request.
 */

import { cache } from "react";
import { headers } from "next/headers";
import type { AppearanceSettings } from "../core/settings.ts";
import { runAsTenant } from "../core/tenant-context.ts";
import { legacyLayoutResponse } from "./health.ts";
import { stores } from "./stores.ts";
import { resolveTenant } from "./tenant.ts";

/** The record's appearance for a request with these headers, or undefined
 *  (factory). Never throws. */
export function bootAppearanceFor(h: Headers): AppearanceSettings | undefined {
	try {
		const tenant = resolveTenant(h);
		if (!tenant || legacyLayoutResponse()) return undefined;
		return runAsTenant(tenant, () => stores.settingsStore.readSettings()?.appearance);
	} catch {
		return undefined;
	}
}

/** The record's appearance for THIS request (one read per request). */
export const readBootAppearance = cache(async (): Promise<AppearanceSettings | undefined> => {
	try {
		return bootAppearanceFor(await headers());
	} catch {
		return undefined;
	}
});
