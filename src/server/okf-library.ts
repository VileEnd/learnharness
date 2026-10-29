/**
 * The app's ONE library service (composition root for the OKF bundle):
 * the wired stores + the freshness service. Kept apart from okf.ts so the
 * service stays constructible with stubs in tests, and apart from library.ts
 * (the document service) because chat-handler needs this one for the agents'
 * file tools and library.ts imports chat-handler.
 *
 * Boot warm-up: importing this module outside tests and outside `next build`
 * builds the bundle once in the background, so the first agent turn finds it.
 */

import { createLibrary, type Library } from "./okf.ts";
import { multiUser } from "../core/tenant-context.ts";
import { tenantSingleton } from "./tenant-singleton.ts";
import { stores } from "./stores.ts";

// One library per tenant (tenantSingleton keeps the map on globalThis: dev HMR
// re-imports modules, the single-flight must survive).
export const library: Library = tenantSingleton("__lhLibraryByTenant", () => {
	const lib = createLibrary({
		okfStore: stores.okfBundleStore,
		graphStore: stores.graphStore,
		documentStore: stores.documentStore,
		chatStore: stores.chatStore,
		learnerStore: stores.learnerStore,
		settings: () => stores.settingsStore.readSettings(),
	});
	// Warm-up on first use: single-user that is at import (first property
	// access), multi-user it is the tenant's first touch of the library.
	if (process.env.NODE_ENV !== "test" && process.env.NEXT_PHASE !== "phase-production-build") void lib.ensureFresh();
	return lib;
});

// Single-user: keep the boot warm-up at import (the instance is built, and
// warmed, by this first touch). Multi-user has no tenant at boot.
if (!multiUser()) void library.root;
