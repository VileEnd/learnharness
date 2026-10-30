/**
 * The admin-managed custom OpenAI-compatible endpoint (upstream port 6):
 * model discovery, and the runtime view the engine consumes.
 *
 * customProviderConfig() is THE read for the engine, pricing, gate and
 * catalog: the global record (never tenant settings) plus its key, paired
 * only while the auth-file binding matches nonce, URL and mode. It re-reads
 * both files on every call and never throws; anything unusable is null.
 *
 * The engine half lives in custom-provider-engine.ts. Pricing and the gate
 * read this same view: free = a real $0, paid = the admin's rates, and a paid
 * model without rates is unpriced (so a capped restricted user never gets it).
 */

import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { customAuthState, customKeyAuthorized, type CustomAuthState } from "./custom-provider-auth.ts";
import { customBindingMatches } from "../core/custom-provider-auth.ts";
import {
	CUSTOM_MODEL_LIMIT,
	clampCustomLimit,
	normalizeBaseUrl,
	resolveCustomModel,
	type CustomModel,
	type CustomProviderConfig,
	type CustomProviderMode,
	type CustomProviderPricing,
	type ResolvedCustomModel,
} from "../core/contracts/custom-provider.ts";
import { stores } from "./stores.ts";

/** A usable endpoint: what the engine registers, prices and gates. */
export interface CustomProviderRuntime {
	baseUrl: string;
	mode: CustomProviderMode;
	pricing: CustomProviderPricing;
	/** Present exactly in key mode. Server-only: never returned by any route. */
	apiKey?: string;
	/** The committed nonce; changes on every connect (a cheap change fingerprint). */
	bindingId: string;
	/** Snapshot order, ladder applied. */
	models: ResolvedCustomModel[];
}

/** The runtime view of one consistent (config, auth) pair, or null when not usable. */
export function customProviderRuntime(config: CustomProviderConfig | null, auth: CustomAuthState): CustomProviderRuntime | null {
	if (!config || !auth.readable || !customBindingMatches(config, auth.binding)) return null;
	if (config.mode === "key" && !customKeyAuthorized(config, auth)) return null;
	return {
		baseUrl: config.baseUrl,
		mode: config.mode,
		pricing: config.pricing,
		...(config.mode === "key" ? { apiKey: auth.key } : {}),
		bindingId: config.bindingId,
		// Own keys only: a model id like "constructor" must never read the prototype.
		models: config.snapshot.map((m) => resolveCustomModel(m, config.models && Object.hasOwn(config.models, m.id) ? config.models[m.id] : undefined)),
	};
}

export function customProviderConfig(): CustomProviderRuntime | null {
	try {
		return customProviderRuntime(stores.customProviderStore.readConfig(), customAuthState());
	} catch {
		return null; // corrupt config or no data root: not configured
	}
}

/** The usable endpoint's models, without the key (catalog, pricing, gate). */
export function customProviderModels(): ResolvedCustomModel[] {
	return customProviderConfig()?.models ?? [];
}

// ─── Pricing and gate (Task 2) ───────────────────────────────────────

/** pi-ai's per-MTok cost shape. */
export interface CustomModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export const FREE_COST: CustomModelCost = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** What one custom model costs per MTok, or null when it is unpriced (paid
 *  without both rates, or not in the usable endpoint at all). Free is the one
 *  sanctioned real zero (local compute). Cached tokens are priced at the
 *  input rate: an OpenAI-compatible host's discount is unknown, so the
 *  estimate never under-counts against a cap. */
export function customModelCost(runtime: CustomProviderRuntime | null, id: string): CustomModelCost | null {
	const model = runtime?.models.find((m) => m.id === id);
	if (!runtime || !model) return null;
	if (runtime.pricing === "free") return FREE_COST;
	if (!model.rates) return null;
	const { inputUsdPerMTok: input, outputUsdPerMTok: output } = model.rates;
	return { input, output, cacheRead: input, cacheWrite: input };
}

/** `custom:<id>` keys a capped restricted user may run: every model in free
 *  mode, only the rated ones in paid mode, none when nothing is usable. */
export function pricedCustomKeys(runtime: CustomProviderRuntime | null = customProviderConfig()): Set<string> {
	const keys = new Set<string>();
	for (const m of runtime?.models ?? []) if (customModelCost(runtime, m.id)) keys.add(`${CUSTOM_PROVIDER.id}:${m.id}`);
	return keys;
}

/** A `custom:<id>` model key (split on the first colon: the id may hold one). */
export function isCustomKey(key: string): boolean {
	return key.startsWith(`${CUSTOM_PROVIDER.id}:`);
}

/** A custom model key outside the priced set (fail closed: an unknown custom key is unpriced too). */
export function isUnpricedCustomKey(key: string, priced: ReadonlySet<string>): boolean {
	return isCustomKey(key) && !priced.has(key);
}

/** Outcome of a discovery probe. `status` is the endpoint's HTTP status when
 *  it answered, so a rejected key is told apart from a missing model list. */
export type DiscoverResult = { ok: true; models: CustomModel[] } | { ok: false; error: string; status?: number; fatal?: boolean };

/** GET {base}/models: 15 s timeout, no redirects, 8 MiB / 10k-model cap.
 *  Keyless sends no bearer. Non-2xx or an unknown shape is an honest error,
 *  never a silent empty list; error text never echoes the response body. */
export async function discoverModels(baseUrl: string, apiKey?: string): Promise<DiscoverResult> {
	const base = normalizeBaseUrl(baseUrl);
	if (!base) return { ok: false, error: "Base URL must be a valid http(s) URL" };
	const key = apiKey?.trim();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(`${base}/models`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: controller.signal,
			redirect: "manual",
		});
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			return { ok: false, error: "Discovery redirects are not allowed", fatal: true };
		}
		if (!res.ok) {
			await res.body?.cancel();
			return { ok: false, error: `Endpoint returned HTTP ${res.status}`, status: res.status };
		}
		const list = extractModels(await readBoundedJson(res, 8 * 1024 * 1024));
		if (list === null) return { ok: false, error: "Endpoint response was not a model list" };
		return { ok: true, models: list };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof CustomBodyLimitError ? err.message : controller.signal.aborted ? "Endpoint timed out" : "Discovery request failed",
			fatal: err instanceof CustomBodyLimitError,
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Advertised models plus every typed id they lack (bare, so pins can correct
 *  it). Discovered metadata always wins over a typed id of the same name. */
export function mergeManualModels(discovered: readonly CustomModel[], manualIds: readonly string[]): CustomModel[] {
	const byId = new Map(discovered.map((m) => [m.id, m]));
	for (const id of manualIds) if (!byId.has(id)) byId.set(id, { id });
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Rows from {data:[…]} | {models:[…]} | a bare array, or null. */
function modelRows(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body;
	if (isRecord(body)) {
		if (Array.isArray(body.data)) return body.data;
		if (Array.isArray(body.models)) return body.models;
	}
	return null;
}

/** Image input from the common modality/capability fields; absent = text-only. */
function detectImage(row: Record<string, unknown>): boolean {
	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const candidates = [architecture?.input_modalities, row.input_modalities, row.modalities, row.supported_modalities, row.capabilities];
	return candidates.some((c) => Array.isArray(c) && c.some((v) => typeof v === "string" && /image|vision/i.test(v)));
}

/** Reasoning from metadata only, never the model name (a false positive sends
 *  reasoning_effort an endpoint rejects). */
function detectReasoning(row: Record<string, unknown>): boolean {
	for (const key of ["reasoning", "supports_reasoning", "thinking"] as const) if (row[key] === true) return true;
	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const candidates = [row.supported_parameters, row.capabilities, row.tags, architecture?.output_modalities];
	return candidates.some((list) => Array.isArray(list) && list.some((v) => typeof v === "string" && (/reasoning/i.test(v) || v.toLowerCase() === "thinking")));
}

function firstPositive(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	}
	return undefined;
}

// Field names seen in the wild for each limit (first present wins).
const CONTEXT_KEYS = ["max_input_tokens", "context_length", "context_window", "max_context", "n_ctx", "max_seq_len", "max_position_embeddings"] as const;
const MAX_OUTPUT_KEYS = ["max_output_tokens"] as const;

/** Models (objects with `id`, or bare strings) with detected capabilities, sorted by id; null for an unknown shape. */
function extractModels(body: unknown): CustomModel[] | null {
	const rows = modelRows(body);
	if (rows === null) return null;
	if (rows.length > CUSTOM_MODEL_LIMIT) throw new CustomBodyLimitError(`Model list exceeds ${CUSTOM_MODEL_LIMIT} entries`);
	const byId = new Map<string, CustomModel>();
	for (const row of rows) {
		if (typeof row === "string") {
			if (row.trim()) byId.set(row.trim(), { id: row.trim() });
			continue;
		}
		if (isRecord(row) && typeof row.id === "string" && row.id.trim()) {
			const id = row.id.trim();
			const model: CustomModel = { id };
			if (detectImage(row)) model.image = true;
			if (detectReasoning(row)) model.reasoning = true;
			const context = firstPositive(row, CONTEXT_KEYS);
			if (context) model.context = clampCustomLimit("context", context);
			const maxOutput = firstPositive(row, MAX_OUTPUT_KEYS);
			if (maxOutput) model.maxOutput = clampCustomLimit("maxOutput", maxOutput);
			byId.set(id, model);
		}
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
