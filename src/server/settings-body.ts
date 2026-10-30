/**
 * The shared settings-PUT body parsers — one seam per settings surface.
 * Extracted verbatim from the per-chat route (default-settings wave,
 * 2026-09-18): identical parse, identical errors. The section parsers
 * (settings-storage wave, 2026-09-19) follow the same house rules.
 *
 * Replace-whole semantics: the client sends the complete desired SECTION;
 * absent fields are absent overrides ({} clears everything). No merges, so
 * a stale client can never resurrect a cleared override. Unknown body keys
 * are dropped (same tolerance as parseSettingsBody) — unknown DISK keys are
 * a different concern and are preserved by the sanitizer (core/settings.ts).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isHexColor, type ChatSettings } from "../core";
import type {
	AgentSettings,
	QuizMechanic,
	AppearanceSettings,
	BackgroundModelRole,
	CompactionSettings,
	DocumentsSettings,
	DictationSettings,
	GeneralSettings,
	GraphSettings,
	ModelsSettings,
	RoleModelOverride,
} from "../core/settings.ts";
import { TURN_SPEND_CAP_MAX_USD, TURN_SPEND_CAP_MIN_USD, QUIZ_MECHANICS, BACKGROUND_MODEL_ROLES, COMPACTION_THRESHOLD_FLOOR, EMBEDDING_MODEL_PATTERN, EXTRACTION_CHUNK_TOKENS_FLOOR, MODEL_SLOTS } from "../core/settings.ts";
import { INTERACTIVE_FORMATS } from "../core/exercise-core.ts";
import { isDictationLanguage } from "../core/dictation.ts";
import { WRITABLE_TOOL_KEYS } from "../core/pending.ts";
import type { ModelNotAllowed } from "../core/settings.ts";
import { disallowedModel } from "./model-gate.ts";

/** Parsed-or-rejected — `ok: false` carries the 400's error message. */
export type SettingsBodyResult<T> =
	| { ok: true; settings: T }
	| { ok: false; error: string };

export function parseSettingsBody(body: unknown): SettingsBodyResult<ChatSettings> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Invalid JSON body" };
	}
	const raw = body as {
		model?: { provider?: unknown; id?: unknown };
		thinkingLevel?: unknown;
		canvas?: unknown;
	};
	const settings: ChatSettings = {};
	// `null` is the explicit clear (see chatSettingsClears): absent from the parse.
	if (raw.model !== undefined && raw.model !== null) {
		if (
			typeof raw.model !== "object" ||
			typeof raw.model.provider !== "string" ||
			typeof raw.model.id !== "string"
		) {
			return { ok: false, error: "model must be {provider, id}" };
		}
		settings.model = { provider: raw.model.provider, id: raw.model.id };
	}
	if (raw.thinkingLevel !== undefined && raw.thinkingLevel !== null) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: "thinkingLevel must be a string" };
		}
		settings.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	if (raw.canvas !== undefined) {
		if (typeof raw.canvas !== "boolean") return { ok: false, error: "canvas must be a boolean" };
		settings.canvas = raw.canvas;
	}
	// Wave 7 killed the graph-context injection (owner: zero configuration
	// beyond chat models — the prober reads its map through tools now); its
	// budget dial is gone with it. A stale client sending the old key has
	// it silently dropped here (forward-compatible, like any unknown key).
	return { ok: true, settings };
}

/** Keys a per-chat PUT body explicitly clears with `null` (the route merges
 *  over the stored settings, where an omitted key means "keep"). Only the
 *  pins can be cleared; call after parseSettingsBody accepted the body. */
export function chatSettingsClears(body: unknown): Array<"model" | "thinkingLevel"> {
	const raw = (body ?? {}) as Record<string, unknown>;
	const out: Array<"model" | "thinkingLevel"> = [];
	if (raw.model === null) out.push("model");
	if (raw.thinkingLevel === null) out.push("thinkingLevel");
	return out;
}

// ─── Section parsers (settings-storage wave, 2026-09-19) ────────────────────
// One parser per settings.json section; the route maps the URL section to
// its parser via SETTINGS_SECTIONS below. Same discipline as
// parseSettingsBody: strict on every known field (a bad type/shape is a
// 400, never a silent clamp/drop), unknown keys dropped.

function asRecord(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

/** general: { autoUpdate?: boolean } */
export function parseGeneralSettingsBody(body: unknown): SettingsBodyResult<GeneralSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: GeneralSettings = {};
	if (raw.autoUpdate !== undefined) {
		if (typeof raw.autoUpdate !== "boolean") {
			return { ok: false, error: "autoUpdate must be a boolean" };
		}
		settings.autoUpdate = raw.autoUpdate;
	}
	return { ok: true, settings };
}

/** agent.models: only the six known background roles; each override's
 *  fields mirror ChatSettings (model pair + independent thinkingLevel). */
function parseRoleOverride(value: unknown, role: string): { ok: true; override: RoleModelOverride } | { ok: false; error: string } {
	const raw = asRecord(value);
	if (!raw) return { ok: false, error: `${role} must be an object` };
	const override: RoleModelOverride = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof (raw.model as Record<string, unknown>).provider !== "string" ||
			typeof (raw.model as Record<string, unknown>).id !== "string"
		) {
			return { ok: false, error: `${role}.model must be {provider, id}` };
		}
		override.model = {
			provider: (raw.model as { provider: string }).provider,
			id: (raw.model as { id: string }).id,
		};
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: `${role}.thinkingLevel must be a string` };
		}
		override.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	return { ok: true, override };
}

/** A boolean map (tools / prompts switches): every value must be boolean. */
function parseBooleanMap(value: unknown, field: string): { map?: Record<string, boolean>; error?: string } {
	if (value === undefined) return {};
	const raw = asRecord(value);
	if (!raw) return { error: `${field} must be an object` };
	const out: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (typeof entry !== "boolean") return { error: `${field}.${key} must be a boolean` };
		out[key] = entry;
	}
	return { map: out };
}

/** agent: { models?, tools?, prompts? } — model/thinking validity against
 *  the catalog is checked by the route (validateChatSettings discipline);
 *  prompt switch-on membership is checked by the route (needs the store). */
export function parseAgentSettingsBody(body: unknown): SettingsBodyResult<AgentSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AgentSettings = {};
	if (raw.models !== undefined) {
		const models = asRecord(raw.models);
		if (!models) return { ok: false, error: "models must be an object" };
		const known = BACKGROUND_MODEL_ROLES as readonly string[];
		const parsed: NonNullable<AgentSettings["models"]> = {};
		for (const [role, value] of Object.entries(models)) {
			if (!known.includes(role)) {
				return { ok: false, error: `unknown role "${role}" (supported: ${known.join(", ")})` };
			}
			const override = parseRoleOverride(value, role);
			if (!override.ok) return { ok: false, error: override.error };
			if (Object.keys(override.override).length) parsed[role as BackgroundModelRole] = override.override;
		}
		if (Object.keys(parsed).length) settings.models = parsed;
	}
	const tools = parseBooleanMap(raw.tools, "tools");
	if (tools.error) return { ok: false, error: tools.error };
	if (tools.map) {
		// Unknown tool keys are rejected at WRITE time (user decision
		// 2026-09-19): the delta is inert while unread, but once the bridge
		// honors it a persisted bogus key would drift. The writable set is
		// the job tools + the quizzing-mechanics switch (explain, owner
		// 2026-09-27). The read-side sanitizer stays lenient for
		// forward-compat.
		const supported = WRITABLE_TOOL_KEYS as readonly string[];
		for (const key of Object.keys(tools.map)) {
			if (!supported.includes(key)) {
				return { ok: false, error: `unknown tool "${key}" (supported: ${supported.join(", ")})` };
			}
		}
		settings.tools = tools.map;
	}
	if (raw.quizMechanic !== undefined) {
		if (typeof raw.quizMechanic !== "string" || !(QUIZ_MECHANICS as readonly string[]).includes(raw.quizMechanic)) {
			return { ok: false, error: `quizMechanic must be one of: ${QUIZ_MECHANICS.join(", ")}` };
		}
		settings.quizMechanic = raw.quizMechanic as QuizMechanic;
	}
	const formats = parseBooleanMap(raw.formats, "formats");
	if (formats.error) return { ok: false, error: formats.error };
	if (formats.map) {
		for (const key of Object.keys(formats.map)) {
			if (!(INTERACTIVE_FORMATS as readonly string[]).includes(key)) {
				return { ok: false, error: `unknown format "${key}"` };
			}
		}
		settings.formats = formats.map;
	}
	const prompts = parseBooleanMap(raw.prompts, "prompts");
	if (prompts.error) return { ok: false, error: prompts.error };
	if (prompts.map) settings.prompts = prompts.map;
	if (raw.search !== undefined) {
		const search = asRecord(raw.search);
		if (!search) return { ok: false, error: "search must be an object" };
		if (search.engine !== undefined) {
			if (search.engine !== "tavily" && search.engine !== "brave") {
				return { ok: false, error: 'search.engine must be "tavily" or "brave"' };
			}
			settings.search = { engine: search.engine };
		}
	}
	// Prober graph tools (wave 7, owner ruling 2026-09-23): an agent-section
	// subsection, not a tool-toggles key — the mechanism is agent capability
	// (tool registration), the subject is the graph. Strict write side:
	// object shape only; `enabled` boolean when present. Absent = ON.
	if (raw.graphTools !== undefined) {
		const graphTools = asRecord(raw.graphTools);
		if (!graphTools) return { ok: false, error: "graphTools must be an object" };
		if (graphTools.enabled !== undefined && typeof graphTools.enabled !== "boolean") {
			return { ok: false, error: "graphTools.enabled must be a boolean" };
		}
		settings.graphTools = graphTools.enabled === undefined ? {} : { enabled: graphTools.enabled };
	}
	// Document tools (PR I): the same strict subsection shape. Absent = ON.
	if (raw.documentTools !== undefined) {
		const documentTools = asRecord(raw.documentTools);
		if (!documentTools) return { ok: false, error: "documentTools must be an object" };
		if (documentTools.enabled !== undefined && typeof documentTools.enabled !== "boolean") {
			return { ok: false, error: "documentTools.enabled must be a boolean" };
		}
		settings.documentTools = documentTools.enabled === undefined ? {} : { enabled: documentTools.enabled };
	}
	// Per-turn spend cap (USD): 0 = unset (the default applies); else in range.
	if (raw.turnSpendCapUsd !== undefined) {
		const cap = raw.turnSpendCapUsd;
		if (typeof cap !== "number" || !Number.isFinite(cap)) return { ok: false, error: "turnSpendCapUsd must be a number" };
		if (cap !== 0 && (cap < TURN_SPEND_CAP_MIN_USD || cap > TURN_SPEND_CAP_MAX_USD)) {
			return { ok: false, error: `turnSpendCapUsd must be 0 (default) or between ${TURN_SPEND_CAP_MIN_USD} and ${TURN_SPEND_CAP_MAX_USD}` };
		}
		if (cap !== 0) settings.turnSpendCapUsd = cap;
	}
	return { ok: true, settings };
}

/** A hex-or-null color field (appearance colors): null = default. */
function parseHexOrNull(value: unknown, field: string): { color?: string | null; error?: string } {
	if (value === null) return { color: null };
	if (typeof value !== "string" || !isHexColor(value)) {
		return { error: `${field} must be a #hex color or null` };
	}
	return { color: value };
}

/** appearance: { mode?, background?, fontFamily?, proseFontSize?,
 *  sessionNameSerif?, mdRendering? } */
export function parseAppearanceSettingsBody(body: unknown): SettingsBodyResult<AppearanceSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AppearanceSettings = {};
	if (raw.mode !== undefined) {
		if (raw.mode !== "dark" && raw.mode !== "light") {
			return { ok: false, error: "mode must be \"dark\" or \"light\"" };
		}
		settings.mode = raw.mode;
	}
	if (raw.background !== undefined) {
		const parsed = parseHexOrNull(raw.background, "background");
		if (parsed.error) return { ok: false, error: parsed.error };
		settings.background = parsed.color ?? null;
	}
	if (raw.fontFamily !== undefined) {
		if (raw.fontFamily !== null && (typeof raw.fontFamily !== "string" || !raw.fontFamily.trim())) {
			return { ok: false, error: "fontFamily must be a non-empty string or null" };
		}
		settings.fontFamily = raw.fontFamily as string | null;
	}
	if (raw.proseFontSize !== undefined) {
		if (
			typeof raw.proseFontSize !== "number" ||
			!Number.isInteger(raw.proseFontSize) ||
			raw.proseFontSize < 12 ||
			raw.proseFontSize > 24
		) {
			return { ok: false, error: "proseFontSize must be an integer between 12 and 24" };
		}
		settings.proseFontSize = raw.proseFontSize;
	}
	if (raw.sessionNameSerif !== undefined) {
		if (typeof raw.sessionNameSerif !== "boolean") {
			return { ok: false, error: "sessionNameSerif must be a boolean" };
		}
		settings.sessionNameSerif = raw.sessionNameSerif;
	}
	if (raw.mdRendering !== undefined) {
		const md = asRecord(raw.mdRendering);
		if (!md) return { ok: false, error: "mdRendering must be an object" };
		const rendering: NonNullable<AppearanceSettings["mdRendering"]> = {};
		if (md.headingWeight !== undefined) {
			if (
				typeof md.headingWeight !== "number" ||
				!Number.isInteger(md.headingWeight) ||
				md.headingWeight < 100 ||
				md.headingWeight > 900
			) {
				return { ok: false, error: "mdRendering.headingWeight must be an integer between 100 and 900" };
			}
			rendering.headingWeight = md.headingWeight;
		}
		if (md.boldColor !== undefined) {
			const parsed = parseHexOrNull(md.boldColor, "mdRendering.boldColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.boldColor = parsed.color ?? null;
		}
		if (md.italicColor !== undefined) {
			const parsed = parseHexOrNull(md.italicColor, "mdRendering.italicColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.italicColor = parsed.color ?? null;
		}
		if (Object.keys(rendering).length) settings.mdRendering = rendering;
	}
	return { ok: true, settings };
}

/** graph: the collapsed section { enabled? } (wave 7, owner ruling
 *  2026-09-23): the master switch ONLY — the embedding/clustering/labeling
 *  rungs and the BYOK embeddingModel died with the provider embedder
 *  (clustering is the free birth-session partition, labels are session
 *  names). Old-shape keys in a body are ignored, not rejected. */
export function parseGraphSettingsBody(body: unknown): SettingsBodyResult<GraphSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	// Wave 7 collapse (owner ruling 2026-09-23) + the extraction-UX
	// redesign (2026-09-24): the section is the master switch and the
	// chunk budget. PUT is replace-whole — a body like {enabled: true} IS
	// the whole section (extractionChunkTokens absent = factory default at
	// resolution); the dead rungs' keys in old records are unread (the
	// sanitizer drops them; see sanitizeGraph).
	const settings: GraphSettings = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
		settings.enabled = raw.enabled;
	}
	if (raw.rendering !== undefined) {
		if (typeof raw.rendering !== "boolean") return { ok: false, error: "rendering must be a boolean" };
		settings.rendering = raw.rendering;
	}
	if (raw.extractionChunkTokens !== undefined) {
		if (typeof raw.extractionChunkTokens !== "number" || !Number.isFinite(raw.extractionChunkTokens)) {
			return { ok: false, error: "extractionChunkTokens must be a number" };
		}
		const floored = Math.floor(raw.extractionChunkTokens);
		if (floored < EXTRACTION_CHUNK_TOKENS_FLOOR) {
			// the floor's rationale lives on GraphSettings.extractionChunkTokens:
			// every run pays the graph-carrying prompt overhead — penny-batches
			// cost more per extracted token than the content is worth.
			return {
				ok: false,
				error: `extractionChunkTokens must be at least ${EXTRACTION_CHUNK_TOKENS_FLOOR} (smaller batches waste the per-run graph overhead)`,
			};
		}
		settings.extractionChunkTokens = floored;
	}
	return { ok: true, settings };
}

/** models: { strong?, cheap?, vision? } — the slot tiers (model slots
 *  wave, 2026-09-20). Each slot is the same shape as a role override; a
 *  present-but-empty slot object is rejected (absent slot = unset; say
 *  what you mean). Catalog validity is checked by the route
 *  (validateChatSettings discipline). */
export function parseModelsSettingsBody(body: unknown): SettingsBodyResult<ModelsSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: ModelsSettings = {};
	for (const key of Object.keys(raw)) {
		// Legacy slot from 0.26.x, ignored.
		if (key === "canvas") continue;
		const known = MODEL_SLOTS as readonly string[];
		if (!known.includes(key)) {
			return { ok: false, error: `unknown slot "${key}" (supported: ${known.join(", ")})` };
		}
		const parsed = parseRoleOverride(raw[key], key);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		// BYOK (owner, 2026-09-22): a slot IS a model choice — no factory
		// floor exists, so a thinkingLevel alone can never run; every slot
		// write must carry the model (the level is an optional rider). An
		// absent slot key clears the tier (replace-whole section).
		if (!parsed.override.model) {
			return { ok: false, error: `slot "${key}" must set a model (thinkingLevel alone cannot run — absent slot = unset)` };
		}
		settings[key as (typeof MODEL_SLOTS)[number]] = parsed.override;
	}
	return { ok: true, settings };
}

/** compaction (owner round 14): the context-compaction threshold — the
 *  projected-token budget over which a session summarizes its own history
 *  into the compaction marker. Strict write side: a present
 *  thresholdTokens must be a number at or above the floor (the floor is
 *  anti-churn: each compaction keeps a ~20k-token recent tail, so a
 *  smaller threshold would re-summarize the tail it just wrote). Absent =
 *  factory default 150k at resolution. Replace-whole, like every
 *  section. */
export function parseCompactionSettingsBody(body: unknown): SettingsBodyResult<CompactionSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: CompactionSettings = {};
	if (raw.thresholdTokens !== undefined) {
		if (typeof raw.thresholdTokens !== "number" || !Number.isFinite(raw.thresholdTokens)) {
			return { ok: false, error: "thresholdTokens must be a number" };
		}
		const floored = Math.floor(raw.thresholdTokens);
		if (floored < COMPACTION_THRESHOLD_FLOOR) {
			return {
				ok: false,
				error: `thresholdTokens must be at least ${COMPACTION_THRESHOLD_FLOOR} (compaction keeps a ~20k-token recent tail — smaller budgets would churn it)`,
			};
		}
		settings.thresholdTokens = floored;
	}
	return { ok: true, settings };
}

/** documents (PR I): the embedding model behind hybrid search. Strict write
 *  side: a present embeddingModel must look like an OpenRouter model id;
 *  empty/absent = the default. Replace-whole, like every section. */
export function parseDocumentsSettingsBody(body: unknown): SettingsBodyResult<DocumentsSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: DocumentsSettings = {};
	if (raw.embeddingModel !== undefined && raw.embeddingModel !== "") {
		const model = typeof raw.embeddingModel === "string" ? raw.embeddingModel.trim() : "";
		if (!EMBEDDING_MODEL_PATTERN.test(model)) {
			return { ok: false, error: 'embeddingModel must be an OpenRouter model id like "baai/bge-m3"' };
		}
		settings.embeddingModel = model;
	}
	if (raw.embeddingBatch !== undefined) {
		if (typeof raw.embeddingBatch !== "boolean") return { ok: false, error: "embeddingBatch must be a boolean" };
		settings.embeddingBatch = raw.embeddingBatch;
	}
	return { ok: true, settings };
}

/** dictation: { language?: one of Nova-3's supported language codes }
 *  ({} clears it: no `language` param). Not a model, so no policy gate. */
export function parseDictationSettingsBody(body: unknown): SettingsBodyResult<DictationSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	if (raw.language === undefined) return { ok: true, settings: {} };
	if (!isDictationLanguage(raw.language)) return { ok: false, error: "Unsupported dictation language" };
	return { ok: true, settings: { language: raw.language } };
}

/** The section→parser map for PUT /api/settings/[section] (the route also
 *  carries the special prompts sub-resource). */
export const SETTINGS_SECTIONS = {
	general: parseGeneralSettingsBody,
	chat: parseSettingsBody,
	agent: parseAgentSettingsBody,
	appearance: parseAppearanceSettingsBody,
	graph: parseGraphSettingsBody,
	compaction: parseCompactionSettingsBody,
	documents: parseDocumentsSettingsBody,
	models: parseModelsSettingsBody,
	dictation: parseDictationSettingsBody,
} as const;

export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;

/** The models a parsed section picks (models slots, agent role overrides,
 *  the chat model). */
function sectionModels(section: string, settings: unknown): ({ provider: string; id: string } | undefined)[] {
	if (!settings || typeof settings !== "object") return [];
	if (section === "models") return MODEL_SLOTS.map((name) => (settings as ModelsSettings)[name]?.model);
	if (section === "agent") return Object.values((settings as AgentSettings).models ?? {}).map((o) => o?.model);
	if (section === "chat") return [(settings as ChatSettings).model];
	return [];
}

/** Per-user models (multi-user design §10): the 403 envelope when a parsed
 *  section picks a model the ambient restricted user may not, else null.
 *  Only NEW picks are checked: a model already stored in that section (an
 *  override from before the policy) rides along when an unrelated knob of
 *  the same section is written. Admins and single-user mode always pass. */
export function sectionModelRefusal(section: string, settings: unknown, stored?: unknown): ModelNotAllowed | null {
	const kept = new Set(sectionModels(section, stored).flatMap((m) => (m ? [`${m.provider}:${m.id}`] : [])));
	return disallowedModel(sectionModels(section, settings).filter((m) => !m || !kept.has(`${m.provider}:${m.id}`)));
}
