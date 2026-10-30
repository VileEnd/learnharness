/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that app/ may import. Route handlers and server components come through
 * here; nothing under app/ touches src/store or src/agent directly.
 */

export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./tenant.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export { NotesImportError } from "../agent/subagents/extraction.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
export * from "./stores.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
// The settings record + prompt overrides (settings-storage wave, 2026-09-19).
// The *Record aliases keep the app/api/settings routes explicit about which
// seam they touch (the raw record, not the chat-section convenience view).
// readSettingsRecord is the READ view (a restricted user's policy overlays
// the model slots, multi-user design §10); read-modify-write paths read the
// raw record through settingsStore so the overlay never reaches the disk.
export {
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export { readSettingsView as readSettingsRecord, assertWithinCap, modelsConfigured, spentThisMonth } from "./model-gate.ts";
export { promptOverrides } from "../store/prompt-overrides.ts";
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// The canonical segment discovery/resolution lives in the agent layer
// (composition is an agent concern); the barrel re-exports it for the
// routes — server→agent is the lawful direction (chat-handler precedent).
export { effectivePromptSegments, allSegmentPaths, readPromptOverride } from "../agent/prompt-segments.ts";

// The auth/keys composition (auth-keys wave, 2026-09-19): the curated
// key catalog + the env-reflecting store behind GET/PUT/DELETE /api/keys.
// Importing this module runs the idempotent boot fill-gap — every consumer
// keeps its plain process.env reads (that seam is the point).
export * from "./keys.ts";
export * from "./search.ts";
export { authStore } from "../store/auth.ts";
export * from "./settings-body.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export * from "./compaction.ts";
export { runPiTurn, piTurnResponse, type PiTurnHandle, type PiTurnSpec } from "./pi/ui-stream.ts";
export * from "./observability.ts";
export * from "./model-catalog.ts";
export { sessionCost } from "./pricing.ts";
export * from "./push.ts";
export * from "./wireguard.ts";
export { TENANT_ID_RE } from "../core/tenant-context.ts";
// The document library (PR G): the service, its scan registry for the dock, and the request-side types.
export { documents, topicBackfill } from "./library.ts";
export { docIndex } from "./doc-index.ts";
export { withActivityRow, scanStatuses, abortScan, incomingFiles, type CheckResult, type ImportTicket, type ImportCompletion, type IncomingFile } from "./documents.ts";
export { OcrError } from "./ocr-client.ts";
// The OKF library (generated bundle + download): the freshness service, the zip writer.
export { library } from "./okf-library.ts";
export { createLibrary, type Library, type LibraryDeps } from "./okf.ts";
export { zipFiles } from "./zip.ts";
export { buildLearnerSnapshot, type LearnerSnapshotDeps } from "./learner-snapshot.ts";
export { learnerSnapshotNow } from "./learner-now.ts";
export { knowledgeViewNow } from "./knowledge-now.ts";
// The cost counter (2026-10-29): the month view, months strip, failures, and the one-time backfill.
export * from "./usage.ts";
export * from "./health.ts";
// Admin Users section: the Keycloak admin client (+ the ambient tenant, for self-demotion checks).
export { createKeycloakAdmin, keycloakAdmin, KeycloakClientRejected, KeycloakError, type AdminUser, type KeycloakAdmin } from "./keycloak-admin.ts";
export { currentTenant } from "../core/tenant-context.ts";
// Admin policy and per-user usage API (multi-user design §10).
export { adminPolicyView, putDefaultsPolicy, putUserPolicy, adminUsage } from "./admin-policy.ts";
// Claude Code (admin-only experiment): the admin toggle route and the toggle read.
export { claudeCodeAdminPut, claudeCodeAdminView } from "./claude-code.ts";
export { claudeCodeEnabled } from "./policy.ts";
// The admin-managed custom endpoint (upstream port 6): the route handlers only; the key-bearing runtime view stays server-internal.
export { customProviderGet, customProviderMutation } from "./custom-provider-http.ts";
