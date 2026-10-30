/**
 * The admin-managed custom OpenAI-compatible endpoint (upstream port 6,
 * upstream b488213 and follow-ups): ONE instance-wide record in
 * <globalDataRoot()>/custom-provider.json, behind CustomProviderStore. It is
 * never tenant settings: pi-ai's model collection is process-wide, so a
 * per-user endpoint would leak to every tenant. Non-secret only; the key
 * lives in LH_AUTH_FILE, bound to URL + mode + nonce (custom-provider-auth.ts).
 * Browser-safe: types and pure helpers only.
 */

// The provider id is CUSTOM_PROVIDER.id (core/auth-keys.ts): model keys are
// `custom:<modelId>`, and ids may contain ":" (Ollama `qwen3:8b`).

/** Budget fallbacks when neither a pin nor the endpoint names a limit. */
export const CUSTOM_MODEL_DEFAULT_CONTEXT = 8192;
export const CUSTOM_MODEL_DEFAULT_MAX_OUTPUT = 4096;
/** Discovery and manual lists are capped at this many models. */
export const CUSTOM_MODEL_LIMIT = 10_000;

export type CustomProviderMode = "keyless" | "key";
/** free: local compute, every call priced $0. paid: priced from per-model rates; no rates = unpriced. */
export type CustomProviderPricing = "free" | "paid";

/** One model the endpoint offers: probed metadata (or a bare typed id). */
export interface CustomModel {
	id: string;
	image?: boolean;
	reasoning?: boolean;
	context?: number;
	maxOutput?: number;
}

/** Admin-entered per-model settings: pins beat the endpoint's metadata; rates price paid calls. */
export interface CustomModelSettings {
	context?: number;
	maxOutput?: number;
	/** Tri-state capability pin: absent = use discovery. */
	reasoning?: boolean;
	inputUsdPerMTok?: number;
	outputUsdPerMTok?: number;
}

export interface CustomProviderConfig {
	version: 1;
	/** Normalized (see normalizeBaseUrl). */
	baseUrl: string;
	mode: CustomProviderMode;
	pricing: CustomProviderPricing;
	/** The nonce the auth-file binding must carry for the key to be used. */
	bindingId: string;
	/** Probed models merged with manualModels; a failed probe on the same URL keeps it. */
	snapshot: CustomModel[];
	/** Ids the admin typed, for an endpoint without a usable /models list. */
	manualModels?: string[];
	/** Pins and rates by model id, pruned to the snapshot's ids. */
	models?: Record<string, CustomModelSettings>;
}

/** A model with the pin > endpoint > default ladder applied. */
export interface ResolvedCustomModel {
	id: string;
	image: boolean;
	reasoning: boolean;
	contextWindow: number;
	maxOutput: number;
	/** Present only when both rates are set. */
	rates?: { inputUsdPerMTok: number; outputUsdPerMTok: number };
}

/** custom-provider.json exists but is unreadable or malformed. Writers must not overwrite it. */
export class CustomProviderCorrupt extends Error {
	constructor() {
		super("custom_provider_corrupt");
		this.name = "CustomProviderCorrupt";
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const rate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Canonical base URL: absolute http(s), no credentials/query/fragment, no trailing slash. "" = invalid. */
export function normalizeBaseUrl(raw: string): string {
	const value = raw.trim();
	if (!value) return "";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "";
	if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) return "";
	return url.toString().replace(/\/+$/, "");
}

/** A typed id list (string split on commas/whitespace, or a string array): trimmed, deduped, typed order kept. */
export function parseModelIds(raw: unknown): string[] {
	const items = typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : [];
	const ids = items.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
	return [...new Set(ids)];
}

/** The strict write side of the per-model map: rejects bad values (the read side never sees them).
 *  Entries for ids outside `liveIds` are pruned; empty entries drop. */
export function parseCustomModelSettings(
	raw: unknown,
	liveIds?: Iterable<string>,
): { ok: true; models: Record<string, CustomModelSettings> } | { ok: false; error: string } {
	if (!isRecord(raw)) return { ok: false, error: "models must be a { modelId: { context?, maxOutput?, reasoning?, inputUsdPerMTok?, outputUsdPerMTok? } } map" };
	const live = liveIds ? new Set(liveIds) : undefined;
	const out: Record<string, CustomModelSettings> = {};
	for (const [key, value] of Object.entries(raw)) {
		const id = key.trim();
		if (!id) return { ok: false, error: "model ids must be non-empty" };
		if (!isRecord(value)) return { ok: false, error: `settings for ${id} must be an object` };
		const entry: CustomModelSettings = {};
		for (const field of ["context", "maxOutput"] as const) {
			const v = value[field];
			if (v === undefined) continue;
			if (!positiveInt(v)) return { ok: false, error: `${field} for ${id} must be a whole number of tokens of at least 1` };
			entry[field] = v;
		}
		if (value.reasoning !== undefined) {
			if (typeof value.reasoning !== "boolean") return { ok: false, error: `reasoning for ${id} must be true or false` };
			entry.reasoning = value.reasoning;
		}
		for (const field of ["inputUsdPerMTok", "outputUsdPerMTok"] as const) {
			const v = value[field];
			if (v === undefined) continue;
			if (!rate(v)) return { ok: false, error: `${field} for ${id} must be a number of at least 0` };
			entry[field] = v;
		}
		if ((entry.inputUsdPerMTok === undefined) !== (entry.outputUsdPerMTok === undefined)) {
			return { ok: false, error: `set both rates for ${id}, or neither` };
		}
		if (live && !live.has(id)) continue;
		if (Object.keys(entry).length) Object.defineProperty(out, id, { value: entry, enumerable: true, configurable: true, writable: true });
	}
	return { ok: true, models: out };
}

function isCustomModel(v: unknown): v is CustomModel {
	if (!isRecord(v) || typeof v.id !== "string" || !v.id.trim()) return false;
	if (v.image !== undefined && typeof v.image !== "boolean") return false;
	if (v.reasoning !== undefined && typeof v.reasoning !== "boolean") return false;
	return (v.context === undefined || positiveInt(v.context)) && (v.maxOutput === undefined || positiveInt(v.maxOutput));
}

/** The store's read check: every field well-formed, or the file is corrupt. */
export function isCustomProviderConfig(v: unknown): v is CustomProviderConfig {
	if (!isRecord(v) || v.version !== 1) return false;
	if (typeof v.baseUrl !== "string" || !v.baseUrl || normalizeBaseUrl(v.baseUrl) !== v.baseUrl) return false;
	if (v.mode !== "keyless" && v.mode !== "key") return false;
	if (v.pricing !== "free" && v.pricing !== "paid") return false;
	if (typeof v.bindingId !== "string" || !/^[a-f0-9]{32}$/.test(v.bindingId)) return false;
	if (!Array.isArray(v.snapshot) || v.snapshot.length > CUSTOM_MODEL_LIMIT || !v.snapshot.every(isCustomModel)) return false;
	if (v.manualModels !== undefined && (!Array.isArray(v.manualModels) || !v.manualModels.every((id) => typeof id === "string" && id.trim()))) return false;
	if (v.models !== undefined) {
		const parsed = parseCustomModelSettings(v.models);
		if (!parsed.ok || Object.keys(parsed.models).length !== Object.keys(v.models as object).length) return false;
	}
	return true;
}

/** The ladder: the admin's pin wins, then the endpoint's metadata, then the compiled default. */
export function resolveCustomModel(model: CustomModel, settings: CustomModelSettings | undefined): ResolvedCustomModel {
	const out: ResolvedCustomModel = {
		id: model.id,
		image: Boolean(model.image),
		reasoning: settings?.reasoning ?? Boolean(model.reasoning),
		contextWindow: settings?.context ?? model.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT,
		maxOutput: settings?.maxOutput ?? model.maxOutput ?? CUSTOM_MODEL_DEFAULT_MAX_OUTPUT,
	};
	if (settings?.inputUsdPerMTok !== undefined && settings.outputUsdPerMTok !== undefined) {
		out.rates = { inputUsdPerMTok: settings.inputUsdPerMTok, outputUsdPerMTok: settings.outputUsdPerMTok };
	}
	return out;
}
