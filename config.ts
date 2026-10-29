import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { multiUser, requireTenant } from "./src/core/tenant-context.ts";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam (2026-09-17): LH_DATA_DIR relocates every
 * MUTABLE record — chat sessions, graph ledgers, the embedding model
 * cache — when set. The Docker image points it at the mounted data volume
 * (/data/data) so nothing is written inside the image's /app.
 * Unset (plain web dev / repo work) it resolves to the repo's data/,
 * byte-for-byte as before. Read-only assets (prompts) stay ROOT-anchored
 * on purpose: they ship inside the image by design.
 */
export const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

/** Entries a pre-multi-user install keeps directly under DATA_ROOT. */
const LEGACY_ENTRIES = ["chats", "graph", "documents", "settings.json"];

/** True in multi-user mode while the old single-user layout still sits at DATA_ROOT. */
export function legacyLayoutPresent(): boolean {
	if (!multiUser() || legacyGone) return false;
	if (LEGACY_ENTRIES.some((e) => fs.existsSync(path.join(DATA_ROOT, e)))) return true;
	legacyGone = true; // absent stays absent; a positive is never cached (the migration flips it at runtime)
	return false;
}
let legacyGone = false;

export class LegacyLayoutError extends Error {
	constructor() {
		super(
			"LegacyLayoutError: single-user data found at the data root; run `node scripts/migrate-to-tenants.mjs --owner <keycloak-sub>` first",
		);
		this.name = "LegacyLayoutError";
	}
}

/** Per-user data root: DATA_ROOT in single-user mode, DATA_ROOT/users/<id> in multi-user mode. */
export function userDataRoot(): string {
	if (legacyLayoutPresent()) throw new LegacyLayoutError();
	return multiUser() ? path.join(DATA_ROOT, "users", requireTenant().id) : DATA_ROOT;
}

/** Instance-wide data root: DATA_ROOT in single-user mode, DATA_ROOT/global in multi-user mode. */
export function globalDataRoot(): string {
	if (legacyLayoutPresent()) throw new LegacyLayoutError();
	return multiUser() ? path.join(DATA_ROOT, "global") : DATA_ROOT;
}

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	/** The (per-user) data root. */
	get data() {
		return userDataRoot();
	},
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	get chats() {
		return path.join(userDataRoot(), "chats");
	},
	get graph() {
		return path.join(userDataRoot(), "graph");
	},
	/** Web Push subscriptions (src/store/push.ts); the VAPID pair is global (globalPush). */
	get push() {
		return path.join(userDataRoot(), "push");
	},
	/** Instance-wide push state: vapid.json. */
	get globalPush() {
		return path.join(globalDataRoot(), "push");
	},
	/** The document library: data/documents/<docId>/{document.md,meta.json} (src/store/documents.ts). */
	get documents() {
		return path.join(userDataRoot(), "documents");
	},
	/** Canvas drawings per chat: data/drawings/<chatId>/{<drw>.json,<drw>.png,assets/,drafts/} (src/store/drawings.ts). */
	get drawings() {
		return path.join(userDataRoot(), "drawings");
	},
	/** The OKF library bundle the agents' read/ls/find/grep tools are rooted at.
	 *  Never created by the tools; absent = "the library is being built".
	 *  Multi-user: LH_LIBRARY_DIR is a parent holding one bundle per user id. */
	get okf() {
		const dir = process.env.LH_LIBRARY_DIR;
		if (!dir) return path.join(userDataRoot(), "okf");
		return multiUser() ? path.join(dir, requireTenant().id) : dir;
	},
	/** The learner model's ledgers: data/learner/attributions.jsonl (src/store/learner.ts). */
	get learner() {
		return path.join(userDataRoot(), "learner");
	},
	/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/agent/provider-events.ts). */
	get debug() {
		return path.join(userDataRoot(), "debug");
	},
	/** The request log: data/logs/requests-YYYY-MM.jsonl + backfill.done (src/store/request-log.ts). */
	get logs() {
		return path.join(userDataRoot(), "logs");
	},
};

// ─── Models ────────────────────────────────────────────────────────────────
// BYOK ALL THE WAY DOWN (owner, 2026-09-22): there are NO factory default
// models. Every engine resolves from the user's model slots (settings.json
// models section: strong/cheap/vision) over per-role/ChatSettings overrides,
// and a chain that ends empty REFUSES honestly (503 models_not_configured).
// .env stays for secrets (API keys) only. What remains here are ENGINE
// CONSTRUCTION FACTS: the thinking-level scale and the default order.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every agent role in the app. The conversation pair (prober/teacher)
 *  resolves chat.model → strong slot; background roles resolve their own
 *  override → tier slot (core/settings-resolution.ts ROLE_SLOT). */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "extractor"
	| "auditor"
	| "describer"
	| "transcriber";

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's extraction
 * pipeline. Line shapes: src/core/contracts.ts. CHAINS ARE THE STORED
 * TRUTH (owner, 2026-09-30): edges are a derived view, never stored.
 */
export const LEDGER_FILES = {
	get nodes() {
		return path.join(PATHS.graph, "nodes.jsonl");
	},
	get chains() {
		return path.join(PATHS.graph, "chains.jsonl");
	},
	get sessions() {
		return path.join(PATHS.graph, "sessions.jsonl");
	},
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry;
	 *  the checkpoint's replacement for chat extractions — notes keep
	 *  sessions.jsonl, whole-file as they are). */
	get coverage() {
		return path.join(PATHS.graph, "coverage.jsonl");
	},
	/** Topic membership (contracts/graph.ts TopicRow, PR H): append-only, written only by the merger. */
	get topics() {
		return path.join(PATHS.graph, "topics.jsonl");
	},
};

/** Topic canonicalisation (PR H): variant topic key -> canonical label,
 *  written by the document service BEFORE extraction, read by the merger. */
export function topicAliasesFile(): string {
	return path.join(PATHS.graph, "topic-aliases.json");
}

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export function sourcesFile(): string {
	return path.join(PATHS.graph, "sources.json");
}
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export function positionsFile(): string {
	return path.join(PATHS.graph, "positions.json");
}

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/render-settings.ts.
 */
export function renderSettingsFile(): string {
	return path.join(PATHS.graph, "render-settings.json");
}

/** The graph-family FORMAT STAMP sidecar (schema-versioning wave,
 *  2026-10-10): one version for the whole family — the four JSONL ledgers,
 *  sources.json, render-settings.json. LAZY v1: absent = v1; the first
 *  graph-family write creates it. positions.json is REBUILDABLE and rides
 *  along unversioned by design (owner ruling). */
export function graphFormatFile(): string {
	return path.join(PATHS.graph, "format.json");
}

/**
 * THE USER SETTINGS RECORD (settings-storage wave, 2026-09-19): one
 * versioned, DELTA-shaped JSON blob at the data-dir seam holding every
 * non-secret product preference — general, agent (background
 * model/thinking overrides + tool toggles + prompt-override switches),
 * appearance, graph. Explicit user choices only: ABSENT keys resolve to the
 * factory defaults compiled into src/core/settings.ts (FACTORY_SETTINGS), so
 * a software update that adds a knob (new tool, new role, new appearance
 * field) needs no migration — old records simply lack the new keys. The
 * version field is a PRIVATE schema counter for breaking shape changes
 * only (field renamed/meaning changed), unrelated to the app release
 * version. Secrets (API keys, login tokens) NEVER live here — auth.json /
 * .env.local keep that role. (The `chat` default-settings section died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot.)
 */
export function settingsFile(): string {
	return path.join(userDataRoot(), "settings.json");
}

/**
 * User prompt-override files (settings-storage wave, 2026-09-19): the
 * per-segment system-prompt overrides mirroring the SOURCE layout
 * (src/agent/prompts/) — the shared base as prompts/system-prompt.md,
 * fragments as prompts/teacher/<file> / prompts/prober/<file>. File
 * PRESENCE alone is not the override: settings.json's agent.prompts map
 * (segmentPath → boolean) is the explicit switch, so a user can keep a
 * customized file on disk but run the source default to compare. The
 * segment list itself is ALWAYS derived from source at runtime (the
 * loader in src/store/prompt-overrides.ts) — code updates that add,
 * remove, or reorder fragments adapt automatically; an override keyed to
 * a vanished segment stops composing but stays on disk.
 */
export function promptsOverrideDir(): string {
	return path.join(globalDataRoot(), "prompts");
}

/**
 * THE AUTH/KEY STORE (auth-keys wave, 2026-09-19): BYOK provider keys in a
 * flat {VAR: value} JSON map — the SAME file the app has always
 * hand-edited (owner decision: option A, zero migration). The Docker image
 * sets LH_AUTH_FILE to /data/auth.json on the data volume (mode 0600); in
 * dev the default is the repo-root auth.json (gitignored, same
 * pattern as .env.local — a worktree may symlink it to the master copy).
 * The SERVER reads/writes this file directly at call time (no restart to
 * change a key); it reflects the values into process.env at boot with
 * FILL-GAP precedence — real environment variables (incl. .env.local in
 * dev) always win (src/server/keys.ts). Hand-edits still work: the file is
 * re-read from disk on every API access. Secrets NEVER go in settings.json
 * — this file keeps that role, alongside .env.local.
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
