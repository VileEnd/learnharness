/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

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
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { setRequestSink } from "../agent/request-log.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
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
};

export type Stores = typeof stores;

// The request log's LLM sink (cost counter): every engine call lands one line
// in data/logs. Wired here because every engine is built behind this module.
// Skipped under tests (the extraction precedent): suites set their own sink,
// and a suite on the real data/ must not write the owner's cost log.
if (process.env.NODE_ENV !== "test") setRequestSink((line) => stores.requestLog.append(line));

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
