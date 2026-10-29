/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { adminPolicyStore } from "../store/admin-policy.ts";
import { chatStore } from "../store/chats.ts";
import { conceptVectorStore } from "../store/concept-vectors.ts";
import { documentStore } from "../store/documents.ts";
import { drawingStore } from "../store/drawings.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { learnerStore } from "../store/learner.ts";
import { okfBundleStore } from "../store/okf.ts";
import { pushStore } from "../store/push.ts";
import { requestLogStore } from "../store/request-log.ts";
import { settingsStore } from "../store/settings.ts";
import { wireGuardStore } from "../store/wireguard.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { multiUser } from "../core/tenant-context.ts";
import { setRequestSink } from "../agent/request-log.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	adminPolicyStore,
	chatStore,
	conceptVectorStore,
	documentStore,
	drawingStore,
	graphStore,
	jobStore,
	learnerStore,
	okfBundleStore,
	pushStore,
	requestLog: requestLogStore,
	settingsStore,
	wireGuardStore,
};

export type Stores = typeof stores;

// The request log's sink (cost counter): every paid call (engine, embeddings,
// search, OCR) lands one line in data/logs. Wired here because every caller is
// built behind this module. Intentionally wired in EVERY non-test process,
// CLI scripts included: their calls are real spend. Only the backfill below is
// limited to the Next server. Skipped under tests (the extraction precedent):
// suites set their own sink, and a suite on the real data/ must not write the
// owner's cost log.
if (process.env.NODE_ENV !== "test") setRequestSink((line) => stores.requestLog.append(line));

// The one-time usage backfill (cost counter): old records enter the log once
// per data dir, off the request path, after boot. Only in the Next server
// (Next inlines NEXT_RUNTIME into its server bundles; CLI scripts that import
// src/server never have it), never under tests (a suite calls
// runUsageBackfill itself) and never during `next build`. The globalThis
// flag survives dev HMR re-imports; usage.ts imports this module, so it is
// loaded lazily. A failure is logged and retried on the next start.
const bootFlags = globalThis as { __lhUsageBackfill?: true };
if (
	process.env.NEXT_RUNTIME === "nodejs" &&
	process.env.NODE_ENV !== "test" &&
	process.env.NEXT_PHASE !== "phase-production-build" &&
	// Multi-user: no tenant at boot; usage.ts ensureBackfill() runs it per
	// tenant on that tenant's first /api/usage read.
	!multiUser() &&
	!bootFlags.__lhUsageBackfill
) {
	bootFlags.__lhUsageBackfill = true;
	setTimeout(() => {
		import("./usage.ts")
			.then((usage) => {
				const { imported } = usage.runUsageBackfill();
				if (imported > 0) console.info(`[usage] backfill imported ${imported} request-log lines`);
			})
			.catch((err: unknown) => console.error("[usage] the usage backfill failed:", err));
	}, 0);
}

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
