/**
 * Storage ports (the hexagonal seams — vision §1 "storage stays swappable").
 *
 * One port per ENTITY, with domain operations — never one generic
 * key/value interface. Core and the service layer that orbits it code
 * against these types only; concrete adapters live in src/store/ (fs
 * JSON/JSONL today, SQLite drop-in later) and are wired exactly once, in
 * the composition root (src/server/stores.ts). Dependencies point one way:
 * adapters may import core; core NEVER imports an adapter.
 */

import type { LhMessage } from "./native-messages.ts";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	GraphChain,
	GraphNode,
	JobKind,
	JobRecord,
	ExtractionRunUsage,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	TopicRow,
	TurnUsage,
	NotesSource,
	RequestLogLine,
} from "./contracts.ts";
import type { DrawingScene } from "./canvas-core.ts";
import type { DocumentMeta, DocumentVectors, PendingBatch } from "./contracts/documents.ts";
import type { OkfFile } from "./contracts/okf.ts";
import type { AttributionRow } from "./contracts/learner.ts";
import type { UserSettings } from "./settings.ts";
import type { WgPeer, WgServerInfo, WgStatus } from "./contracts/wireguard.ts";

// ─── ChatStore — the session record's home (data/chats) ─────────────────────

export interface ChatStore {
	/** Create a session record (persisted immediately). */
	/** Create a session record; kind "practice" marks a practice session
	 *  (absent = teach, the default). */
	createChat(title: string, kind?: "practice"): ChatRecord;
	/** The full record, or null if unknown id / corrupt file. */
	getChat(id: string): ChatRecord | null;
	/** All sessions, newest activity first (the sidebar's list view). */
	listChats(): ChatSummary[];
	/** Persist the full native message list (the record IS the agent
	 * state — Wave B, owner-approved 2026-09-26). */
	saveMessages(id: string, messages: LhMessage[]): void;
	/** Persist the session plan tree (plan tools call this in execute). */
	saveTree(id: string, tree: PlanTree): void;
	/** Append one usage entry to the record's turn log (the money channel,
	 * 2026-09): idempotent per turn id — each request carries its own, so
	 * a turn persisted twice appends once while continuation turns (which
	 * share a response message id) each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): void;
	/** Append one extraction-run usage entry — idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): void;
	/** Persist the per-chat model/thinking settings (the model control).
	 *  Replace-whole: the picker sends the complete settings object. */
	saveSettings(id: string, settings: ChatSettings): void;
	/** Rename a session (the header's click-to-edit title, 2026-09-17).
	 * Like saveSettings: a rename is NOT conversation activity — updatedAt
	 * stays put, so sidebar order never churns on a rename. */
	renameChat(id: string, title: string): ChatRecord;
	/** Delete the session record entirely (session-deletion wave 6, owner
	 *  2026-09-22). False when the id is unknown. The graph-ledger purge and
	 *  job cleanup are the caller's choreography (core/graph-deletion.ts +
	 *  the DELETE route), not the store's. */
	deleteChat(id: string): boolean;
}

// ─── GraphStore — the append-only evidence ledgers (data/graph) ──────────────
// Chains are the stored truth (owner, 2026-09-30): nodes + reasoning
// chains; edges are a DERIVED view (core/graph.ts) and never touch this
// seam. Reads return the raw append-order lines; merging chain assertions
// by (premises, conclusion) is DERIVED in core/graph.ts — the store never
// decides. The extraction pipeline is the sole writer; this read surface
// stays.

export interface GraphStore {
	/** Append one GraphNode (ids are unique — no merging needed). */
	appendNode(node: GraphNode): void;
	/** Raw node lines in append order. */
	readNodes(): GraphNode[];

	/** Append one chain ASSERTION (a second session asserting the same
	 *  (premises, conclusion) appends another line; readers merge). */
	appendChain(assertion: GraphChain): void;
	readChains(): GraphChain[];

	/** Append one emission checkpoint. */
	appendCheckpoint(checkpoint: SessionCheckpoint): void;
	readCheckpoints(): SessionCheckpoint[];
	/** Message-granular extraction coverage (vision-extraction-coverage.md):
	 *  append-only; one line per covered message. The chat-extraction
	 *  checkpoint — "uncovered" is derived from these, never tracked. */
	appendCoverage(entry: CoverageEntry): void;
	readCoverage(): CoverageEntry[];
	/** Topic membership (PR H): append-only; the merger is the only writer. */
	appendTopic(row: TopicRow): void;
	/** Raw topic rows in append order (corrupt lines skipped). */
	readTopics(): TopicRow[];
	/** The topic alias table (variant topic key -> canonical label). Not a
	 *  ledger: the document service and the session extraction replace
	 *  it whole BEFORE the merge (under the alias lock, core/topics.ts); the
	 *  merger only reads it. */
	readTopicAliases(): Record<string, string>;
	writeTopicAliases(aliases: Record<string, string>): void;

	/** Append one cluster-naming run's usage (graph-global money channel) —
	 *  idempotent per startedAt. */

	/** Upsert one imported-notes source record (config.sourcesFile() — a
	 *  JSON map, not a ledger; an upsert keeps the existing usage log). */
	upsertSource(source: NotesSource): void;
	/** Every notes source record, by id order-insensitive. */
	readSources(): NotesSource[];
	/** Append one run's usage to a source record — idempotent per
	 *  startedAt, mirroring ChatRecord.extractions. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void;

	/** The layout ledger (config.positionsFile()): nodeId → resting {x,y}.
	 *  WRITTEN ONLY by the incremental settle after a merge (core/layout.ts
	 *  settleGraphLayout) — read-only for everything else. */
	readPositions(): Record<string, Position>;
	/** Replace the whole ledger (the settle is a full-graph computation). */
	writePositions(positions: Record<string, Position>): void;

	/** THE DESTRUCTIVE SEAM (session-deletion wave 6, owner 2026-09-22 —
	 *  the first non-append operation on these ledgers): atomically
	 *  replace the full contents of any subset of the six rewritable
	 *  ledgers. Each provided array is written to a temp file and renamed
	 *  over the ledger (crash-safe: a torn write never replaces the
	 *  original); absent keys leave their ledger untouched. The pure
	 *  computation is core/graph-deletion.ts — the store only makes the
	 *  replacement atomic. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
		topics?: TopicRow[];
	}): void;
}

// ─── JobStore — background sub-agent jobs (data/jobs) ─────────────────────────

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** First activity line (defaults to "starting"). */
	activity?: string;
	/** Saved on the job before its worker is spawned. */
	input?: unknown;
}

/** Mergeable fields — identity (id, kind, chatId, toolCallId, createdAt) is immutable. */
export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	/** Create a running job (keyed by toolCallId for spawn dedup). */
	createJob(init: CreateJobInit): JobRecord;
	getJob(id: string): JobRecord | null;
	/** Merge a patch into the record; null if unknown id. */
	updateJob(id: string, patch: JobPatch): JobRecord | null;
	/** All jobs for a chat, newest activity first. */
	listJobs(chatId: string): JobRecord[];
	/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
	findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null;
	/** Delete every job record for a chat — running or finished (session-
	 *  deletion wave 6). Returns how many files were removed. The deletion
	 *  route refuses while jobs are still running, so by the time this
	 *  fires every record is terminal. */
	deleteJobsForChat(chatId: string): number;
}

// ─── SettingsStore — THE user settings record (settings-storage wave, 2026-09-19) ──

/**
 * The one record for every non-secret product preference (core/settings.ts
 * UserSettings — delta semantics, see that module's doc). The store is
 * replace-whole on the RECORD; per-section scoping is a server-band concern
 * (single process, no stale-client hazard to defend against at this seam).
 * Schema-version lazy migration happens inside readSettings, never in
 * the callers. (The legacy default-settings.json fold died with the chat
 * section — per-session models, owner 2026-09-28.)
 */
export interface SettingsStore {
	/** The sanitized record, or null when none exists yet (first boot). */
	readSettings(): UserSettings | null;
	/** Persist the record (replace-whole). Callers pass a SANITIZED record. */
	writeSettings(settings: UserSettings): void;
}

// ─── PromptOverrideStore — per-segment system-prompt overrides (2026-09-19) ──

/**
 * User text overriding ONE source prompt segment (the shared base or one
 * numeric fragment), stored at the data-dir seam mirroring the source
 * layout (config.promptsOverrideDir()). File presence is NOT the override:
 * the settings record's agent.prompts switch is the explicit on/off, so a
 * user can keep a customized file on disk while running the source default.
 * The segment LIST is always derived from source at runtime — see the
 * adapter (src/store/prompt-overrides.ts) for the loader rules.
 */
export interface PromptOverrideStore {
	/** Every override path currently on disk ("system-prompt.md",
	 *  "teacher/20-teaching.md", ...), POSIX-relative, sorted. */
	listOverrides(): string[];
	/** The override text, or null when the path has no file. */
	readOverride(segmentPath: string): string | null;
	/** Persist override text for a segment path (creates parents). */
	writeOverride(segmentPath: string, text: string): void;
	/** Remove the override file, if present (switches are untouched — an
	 *  on-switch with no file composes the source default, inert). */
	deleteOverride(segmentPath: string): void;
}

// ─── AuthStore — BYOK provider keys (auth-keys wave, 2026-09-19) ────────────

/**
 * The long-standing flat {VAR: value} auth.json map (config.AUTH_FILE) —
 * the same file the app has always hand-edited, now first-class
 * server-managed. Values are opaque strings: shape validation is a
 * server-band concern (core/auth-keys.ts validateKeyShape — the store
 * persists what it is given); env precedence is a server-band concern
 * too (src/server/keys.ts). Unknown vars ride along verbatim.
 */
export interface AuthStore {
	/** The whole map — absent or corrupt file = {} ("no keys yet", the
	 *  documented first-boot state). Never throws. */
	authVars(): Record<string, string>;
	/** Set one VAR (atomic write, mode 0600 always, other vars preserved). */
	setAuthVar(name: string, value: string): void;
	/** Remove one VAR if present (absent = no-op, still a silent success). */
	deleteAuthVar(name: string): void;
}


// ─── PushStore — Web Push subscriptions + VAPID keys (data/push) ────────────

/** One device's push subscription (the browser's PushSubscription JSON plus
 *  bookkeeping). The endpoint is the identity. */
export interface PushSubscriptionRecord {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	createdAt: string;
	/** Human label for the device ("Chrome on Android" — from the UA). */
	label: string;
}

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

/**
 * Push subscriptions and the server's VAPID key pair. src/server/push.ts is
 * the only writer. Absent/corrupt files read as empty / null (first-boot
 * state); the VAPID file is the one secret and is written 0600.
 */
export interface PushStore {
	listSubscriptions(): PushSubscriptionRecord[];
	/** Insert, or replace the record with the same endpoint. */
	saveSubscription(sub: PushSubscriptionRecord): void;
	/** Drop by endpoint (absent = no-op). */
	removeSubscription(endpoint: string): void;
	/** The key pair, or null until first use generates it. */
	readVapid(): VapidKeys | null;
	writeVapid(keys: VapidKeys): void;
}

// ─── WireGuardStore — admin-managed VPN devices (<global>/wireguard) ────────

/**
 * peers.json is app-written (atomic, 0600); server.json and status.json are
 * written by the host and only read (absent or invalid: null). `readPeers`
 * throws `PeersFileCorrupt` when peers.json exists but is corrupt, so no writer
 * can overwrite it.
 */
export interface WireGuardStore {
	readServer(): WgServerInfo | null;
	readPeers(): WgPeer[];
	writePeers(peers: WgPeer[]): void;
	readStatus(): WgStatus | null;
}

// ─── DocumentStore — the document library (data/documents) ──────────────────

/**
 * Imported source documents: `<docId>/document.md` (the full markdown) plus
 * `<docId>/meta.json`. src/server/documents.ts is the only writer. Reads
 * never throw: unknown ids and corrupt files read as absent. Writes are
 * atomic (temp + rename), document first and meta last, so a meta only ever
 * points at a complete document.
 */
export interface DocumentStore {
	/** Every document's meta (sketch included), newest import first. */
	listMetas(): DocumentMeta[];
	getMeta(id: string): DocumentMeta | null;
	/** The stored markdown, or null. */
	readMarkdown(id: string): string | null;
	/** Create or replace a document (same id = same document). */
	save(meta: DocumentMeta, markdown: string): void;
	/** Remove a document entirely (false when unknown). */
	remove(id: string): boolean;
	/** The stored embeddings (vectors.f32 + chunks.json), or null when absent,
	 *  torn or stale (computed from other text than the document holds now). */
	readVectors(id: string): DocumentVectors | null;
	/** Persist embeddings (atomic, vectors first, chunks.json last). The
	 *  search index asks the store to write - it never touches files itself. */
	writeVectors(id: string, vectors: DocumentVectors): void;
	/** Embedding batches submitted to OpenRouter and not yet read back
	 *  (data/documents/pending-batches.json); [] when absent or corrupt. */
	readPendingBatches(): PendingBatch[];
	/** Replace the whole pending list (atomic). */
	writePendingBatches(batches: PendingBatch[]): void;
}

// ─── DrawingStore — canvas drawings per chat (data/drawings) ────────────────

/**
 * Content-addressed drawing submissions (scene json + png), uploaded image
 * assets, per-call drafts (revisioned, optimistic) and transcript caches,
 * all under data/drawings/<chatId>/. The chat record stays the truth; these
 * are the only non-record drawing files. Reads never throw: unknown or
 * path-shaped ids read as absent. Writes are atomic.
 */
export interface DrawingStore {
	/** Id = drawingIdOf(scene) (computed here); an existing <id>.json is not rewritten. */
	saveSubmission(chatId: string, scene: DrawingScene, png: Uint8Array): { drawingId: string };
	getScene(chatId: string, drawingId: string): DrawingScene | null;
	getPng(chatId: string, drawingId: string): Uint8Array | null;
	saveAsset(chatId: string, bytes: Uint8Array, mimeType: "image/png" | "image/jpeg"): { assetId: string };
	getAsset(chatId: string, assetId: string): { bytes: Uint8Array; mimeType: string } | null;
	readDraft(chatId: string, callId: string): { scene: DrawingScene; rev: number } | null;
	/** Optimistic write: ok only when baseRev equals the stored rev (0 = none yet). */
	writeDraft(
		chatId: string,
		callId: string,
		scene: DrawingScene,
		baseRev: number,
	): { ok: true; rev: number } | { ok: false; current: { scene: DrawingScene; rev: number } | null };
	readTranscript(chatId: string, drawingId: string): { model: string; text: string } | null;
	writeTranscript(chatId: string, drawingId: string, t: { model: string; text: string }): void;
	/** Remove the chat's whole drawings folder. */
	deleteForChat(chatId: string): void;
}

// ─── ConceptVectorStore — embeddings of the graph's concepts ────────────────

/** The embeddings of concepts (data/graph/concept-vectors.json + .f32), keyed
 *  `cpt_<nodeId>`. `offset` is the entry's row in `vectors` (row-major,
 *  dims wide); `contentHash` = sha256(name + statement), so a vector is only
 *  reused for the text it was computed from. One model for the whole file. */
export interface ConceptVectors {
	model: string;
	dims: number;
	entries: Record<string, { contentHash: string; offset: number }>;
	vectors: Float32Array;
}

/** Sole writer of concept-vectors.*; writes are atomic (vectors first, json last).
 *  Reads never throw and never create anything: absent, torn or corrupt reads as null. */
export interface ConceptVectorStore {
	read(): ConceptVectors | null;
	write(vectors: ConceptVectors): void;
}

// ─── OkfBundleStore — the generated library bundle (data/okf) ───────────────

/**
 * The OKF bundle is a REGENERABLE CACHE of the ledgers, written ONLY through
 * this port (src/server/okf.ts decides when; core/okf.ts renders what). The
 * rebuild is atomic: the files are written into a sibling temp directory and
 * renamed over the root, so a reader sees the previous complete bundle or the
 * new complete one, never a half-written tree. The stamp (`<root>.stamp`, beside the bundle so agents never see it)
 * records which source state the bundle was built from. Reads never throw
 * and never create anything.
 */
export interface OkfBundleStore {
	/** Replace the whole bundle atomically (the old stamp stays until writeStamp). */
	replaceAll(files: OkfFile[]): void;
	/** The stamp of the current bundle, or null when absent. */
	readStamp(): string | null;
	/** Record the source stamp (atomic; the bundle root must exist). */
	writeStamp(stamp: string): void;
}

// ─── LearnerStore — the learner model's ledger (data/learner) ───────────────

/**
 * The attribution ledger: which concepts a graded-but-untagged question
 * belongs to (data/learner/attributions.jsonl). Append-only, written only
 * through this port (the attribution stage is the sole caller). Reads never
 * throw and never create anything: an absent or torn ledger reads as empty.
 */
export interface LearnerStore {
	appendAttribution(row: AttributionRow): void;
	readAttributions(): AttributionRow[];
}

/**
 * The request log (data/logs/requests-YYYY-MM.jsonl): append-only, one line per
 * paid call. Reads never throw and never create anything; the directory is
 * created by the first append. The backfill marker records that old chat
 * usage was imported once.
 */
export interface RequestLogStore {
	append(line: RequestLogLine): void;
	readMonth(month: string): RequestLogLine[];
	months(): string[];
	backfillDone(): boolean;
	markBackfilled(): void;
}
