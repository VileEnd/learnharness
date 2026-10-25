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
import { stores } from "./stores.ts";

interface LibraryGlobal {
	__lhLibrary?: Library;
}

// globalThis anchor: dev HMR re-imports modules, the single-flight must survive.
export const library: Library = ((globalThis as LibraryGlobal).__lhLibrary ??= (() => {
	const lib = createLibrary({
		okfStore: stores.okfBundleStore,
		graphStore: stores.graphStore,
		documentStore: stores.documentStore,
		chatStore: stores.chatStore,
		settings: () => stores.settingsStore.readSettings(),
	});
	if (process.env.NODE_ENV !== "test" && process.env.NEXT_PHASE !== "phase-production-build") void lib.ensureFresh();
	return lib;
})());
