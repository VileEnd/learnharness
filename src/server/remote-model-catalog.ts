/**
 * The model catalog refresh from pi.dev (upstream port, 1cfb7ea2 + 1f77ebc9;
 * owner ruling 2026-11-24): new model ids for keyed builtin providers, without
 * waiting for a Pi upgrade.
 *
 * - Admin only: the POST /api/models button and one automatic refresh a day
 *   (admin.json `modelCatalog.autoRefresh`, absent = on).
 * - Admitted: only NEW ids, only for builtin key providers that have a key,
 *   and only on a route a bundled model of that provider already uses (exact
 *   api + baseUrl; headers come from that bundled model, never the feed).
 *   Every row and every compatibility flag is validated; one eligible but
 *   invalid row fails the whole refresh and nothing is published.
 * - One snapshot for every user: <globalDataRoot()>/model-catalog.json,
 *   overlaid on the bundled catalog (src/agent/models.ts). Startup reads only
 *   the local file; no network.
 * - Existing rules still apply: the overlay flows through piModels(), so the
 *   admin model gate and allow-lists decide who may use an imported model,
 *   and its feed prices are read by src/server/pricing.ts like any price.
 *
 * pi.dev is a fixed host, never model-steered or user-supplied, so the fetch
 * is plain fetch with a timeout, `redirect: "error"` and a byte cap per shard,
 * not the outbound guard. Only provider ids leave the process (no keys, no
 * user ids). The catalog is a free, unauthenticated read, so it is not a line
 * in the paid request log.
 */

import { isDeepStrictEqual } from "node:util";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { hasApi, type Api, type Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import { setModelCatalogOverlay } from "../agent/models.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import type { ModelCatalogRefreshOutcome } from "../core/contracts/models.ts";
import { MAX_MODEL_CATALOG_BYTES } from "../store/model-catalog.ts";
import { readBoundedJson } from "./custom-provider-body.ts";
import { providerKeyPresent } from "./keys.ts";
import { modelCatalogAutoRefresh } from "./policy.ts";
import { stores } from "./stores.ts";

export const PI_CATALOG_ORIGIN = "https://pi.dev";
const MAX_SHARD_BYTES = 2 * 1024 * 1024;
const MAX_SHARD_ROWS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 3600 * 1000;
/** The automatic refresh never fires sooner than this after boot. */
const BOOT_DELAY_MS = 5 * 60 * 1000;

// Only the builtin API-key chat providers with a bundled catalog. Providers
// that refresh their own models (Radius), the custom endpoint and Claude Code
// are not pi.dev shards. Built from the unwrapped providers, never piModels().
const keyProviders = new Set(AUTH_PROVIDER_KEYS.map(({ id }) => id));
let builtinsCache: Map<string, readonly Model<Api>[]> | undefined;
function builtins(): Map<string, readonly Model<Api>[]> {
	return (builtinsCache ??= new Map(builtinProviders().flatMap((provider) => {
		const models = provider.getModels();
		return keyProviders.has(provider.id) && !provider.refreshModels && models.length > 0
			? [[provider.id, models] as const] : [];
	})));
}

const id = z.string().min(1).max(256).regex(/^[\w.~:@-]+(?:\/[\w.~:@-]+)*$/)
	.refine((value) => !value.split("/").some((part) => part === "." || part === ".."));
const rate = z.number().min(0).max(1_000_000);
const rates = z.object({ input: rate, output: rate, cacheRead: rate, cacheWrite: rate });
const tokens = z.number().int().positive().max(100_000_000);
const thinking = z.string().max(32).regex(/^[\w-]*$/).nullable().optional();
const byteLimit = z.number().int().positive().max(1024 ** 3).optional();
const imageDimension = z.number().int().positive().max(8192).optional();
const imageCount = z.number().int().positive().max(10_000).optional();
const cacheSeconds = z.number().positive().max(30 * 24 * 3600).optional();
const rowSchema = z.object({
	type: z.literal("chat").optional(),
	id,
	name: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]*$/),
	api: z.string(),
	baseUrl: z.string(),
	reasoning: z.boolean(),
	thinkingLevelMap: z.object({ off: thinking, minimal: thinking, low: thinking, medium: thinking, high: thinking, xhigh: thinking, max: thinking }).optional(),
	input: z.array(z.enum(["text", "image"])).min(1).max(2).refine((values) => values.includes("text") && new Set(values).size === values.length),
	inputLimits: z.strictObject({
		maxRequestBytes: byteLimit,
		images: z.strictObject({
			maxPerMessage: imageCount, maxPerRequest: imageCount,
			resize: z.strictObject({ maxWidth: imageDimension, maxHeight: imageDimension, maxBytes: byteLimit, jpegQuality: z.number().int().min(1).max(100).optional() }).optional(),
		}).optional(),
	}).optional(),
	promptCache: z.strictObject({ short: cacheSeconds, long: cacheSeconds }).optional(),
	cost: rates.extend({ tiers: z.array(rates.extend({ inputTokensAbove: tokens })).max(8).optional() }),
	contextWindow: tokens,
	maxTokens: tokens,
});

// Pi 1.6.0 wire flags, per transport (every bundled model passes these; the
// test pins that). Unknown behavior fails closed; the values below are
// bounded, never arbitrary request arguments.
const flag = z.boolean().optional();
const sessionAffinity = z.enum(["openai", "openai-nosession", "openrouter"]).optional();
const cacheKeyMode = z.enum(["auto", "enabled", "disabled"]).optional();
const commonOpenAI = {
	supportsDeveloperRole: flag, supportsMidConvoSystemMessages: flag, supportsStrictMode: flag,
	supportsOpenAIGrammarTools: flag, supportsLongCacheRetention: flag,
	sessionAffinityFormat: sessionAffinity, promptCacheKeyMode: cacheKeyMode,
};
const completionsCompat = z.strictObject({
	...commonOpenAI,
	supportsStore: flag, supportsReasoningEffort: flag, supportsUsageInStreaming: flag, supportsFinishReason: flag,
	requiresToolResultName: flag, requiresAssistantAfterToolResult: flag, requiresNonNullAssistantContent: flag,
	requiresToolsWithToolHistory: flag, requiresThinkingAsText: flag, requiresReasoningContentOnAssistantMessages: flag,
	maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
	thinkingFormat: z.enum(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"]).optional(),
	zaiToolStream: flag, supportsThinkingTokenBudget: flag, supportsMidConvoToolAdditions: flag, sendSessionAffinityHeaders: flag,
	thinkingTokenBudgetField: z.enum(["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]).optional(),
	cacheControlFormat: z.literal("anthropic").optional(),
	vllmPriority: z.number().int().min(-1000).max(1000).optional(),
});
const responsesCompat = z.strictObject({
	...commonOpenAI,
	supportsAdditionalTools: flag, supportsToolSearch: flag, supportsExplicitPromptCacheMode: flag,
	supportsMidConvoEffort: flag, supportsMaxOutputTokens: flag,
	// Present in bundled data for xAI, even though the Responses adapter ignores it.
	supportsReasoningEffort: flag,
});
const anthropicCompat = z.strictObject({
	forceAdaptiveThinking: flag, supportsTemperature: flag, supportsEagerToolInputStreaming: flag, supportsCacheControlOnTools: flag,
	supportsLongCacheRetention: flag, sendSessionAffinityHeaders: flag, sessionAffinityFormat: z.literal("openrouter").optional(),
	allowEmptySignature: flag, supportsStrictTools: flag, supportsMidConvoEffort: flag,
	supportsMidConvoSystemMessages: flag, supportsMidConvoToolChanges: flag, supportsMessageThreads: flag,
});
const mistralCompat = z.strictObject({ supportsMidConvoSystemMessages: flag });
const noCompat = z.strictObject({});

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function catalogRows(body: unknown): unknown[] {
	// Pi accepts an array, a {models:[]} envelope, or an id map.
	const rows = Array.isArray(body) ? body : record(body) ? ("models" in body ? body.models : Object.values(body)) : null;
	if (!Array.isArray(rows) || rows.length > MAX_SHARD_ROWS || !rows.every((row) => record(row) && typeof row.id === "string")) {
		throw new Error("Invalid pi.dev catalog");
	}
	return rows;
}

function checkedCompat(api: Api, baselines: readonly Model<Api>[], raw: unknown): Model<Api>["compat"] {
	if (raw === undefined) return undefined;
	if (!record(raw)) throw new Error("Invalid pi.dev model compatibility");
	// Ignore feed-controlled routing/fallback choices. If a thinking format
	// needs a template, accept only an exact profile shipped for this route
	// and pass the bundled copy, never arbitrary feed arguments.
	const { openRouterRouting: _or, vercelGatewayRouting: _vg, allowedFallbackModels: _af, chatTemplateArgs, chatTemplateKwargs, ...claims } = raw;
	switch (api) {
		case "openai-completions": {
			const flags = completionsCompat.parse(claims);
			if (flags.thinkingFormat === "baseten" || flags.thinkingFormat === "chat-template" || chatTemplateArgs !== undefined || chatTemplateKwargs !== undefined) {
				const trusted = baselines.filter((model) => hasApi(model, "openai-completions")).find((model) =>
					model.compat?.thinkingFormat === flags.thinkingFormat
					&& isDeepStrictEqual(model.compat?.chatTemplateArgs, chatTemplateArgs)
					&& isDeepStrictEqual(model.compat?.chatTemplateKwargs, chatTemplateKwargs));
				if (!trusted) throw new Error("Unsupported pi.dev model template");
				return { ...flags, chatTemplateArgs: trusted.compat?.chatTemplateArgs, chatTemplateKwargs: trusted.compat?.chatTemplateKwargs };
			}
			return flags;
		}
		default:
			if (chatTemplateArgs !== undefined || chatTemplateKwargs !== undefined) throw new Error("Unexpected pi.dev model template");
			if (api === "openai-responses") return responsesCompat.parse(claims);
			if (api === "anthropic-messages") return anthropicCompat.parse(claims);
			if (api === "mistral-conversations") return mistralCompat.parse(claims);
			noCompat.parse(claims);
			return undefined;
	}
}

/** The admissible models of one provider's feed: new ids on a bundled route,
 *  fully validated. Skips (not failures): non-chat kinds, bundled ids and
 *  routes the shipped provider does not use. An eligible invalid row throws. */
export function checkedModels(provider: string, rows: readonly unknown[]): Model<Api>[] {
	const baseline = builtins().get(provider);
	if (!baseline) return [];
	const known = new Set(baseline.map((model) => model.id));
	const models = new Map<string, Model<Api>>();
	for (const row of rows) {
		if (!record(row) || typeof row.id !== "string") throw new Error("Invalid pi.dev model");
		if (row.type === "image" || row.type === "classifier" || known.has(row.id)) continue;
		if (typeof row.api !== "string" || !row.api || typeof row.baseUrl !== "string" || !row.baseUrl) throw new Error("Invalid pi.dev model route");
		const routes = baseline.filter((model) => model.api === row.api && model.baseUrl === row.baseUrl);
		const route = routes[0];
		if (!route) continue;
		const { id, api: _api, baseUrl: _baseUrl, ...metadata } = rowSchema.parse(row);
		if ((row.provider !== undefined && row.provider !== provider) || models.has(id) || (route.api === "google-generative-ai" && id.includes(":"))) {
			throw new Error("Invalid pi.dev model identity");
		}
		// Model.samplingParams and its per-level variant allow arbitrary
		// request keys in Pi. Do not import models that require them.
		for (const raw of [row.samplingParams, row.samplingParamsByThinkingLevel]) {
			if (raw !== undefined && (!record(raw) || Object.keys(raw).length)) throw new Error("Unsupported pi.dev sampling parameters");
		}
		const compat = checkedCompat(route.api, routes, row.compat);
		models.set(id, {
			...metadata, id, provider, api: route.api, baseUrl: route.baseUrl,
			...(route.headers ? { headers: route.headers } : {}),
			...(compat ? { compat } : {}),
		});
	}
	return [...models.values()];
}

type Catalog = Map<string, readonly Model<Api>[]>;
interface State {
	snapshot: Catalog;
	/** When a refresh last reached pi.dev successfully (ISO), from the file. */
	checkedAt: string | null;
	/** When the last refresh attempt ended (ms), success or not: in memory. */
	attemptedAt: number;
	refreshing?: Promise<ModelCatalogRefreshOutcome>;
	timer?: ReturnType<typeof setTimeout>;
}
const STATE_KEY = Symbol.for("lh.remote-model-catalog");
const catalogGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: State };

function readSnapshot(): { snapshot: Catalog; checkedAt: string | null } {
	try {
		const saved = stores.modelCatalogStore.readSnapshot();
		if (record(saved) && saved.version === 1 && record(saved.providers)) {
			const providers = saved.providers;
			const snapshot: Catalog = new Map([...builtins().keys()].flatMap((provider) => {
				const models = Array.isArray(providers[provider]) ? checkedModels(provider, catalogRows(providers[provider])) : [];
				return models.length ? [[provider, models] as const] : [];
			}));
			const checkedAt = typeof saved.checkedAt === "string" && Number.isFinite(Date.parse(saved.checkedAt)) ? saved.checkedAt : null;
			return { snapshot, checkedAt };
		}
	} catch { /* Missing/unreadable/invalid snapshot: the bundled catalog is still usable. */ }
	return { snapshot: new Map(), checkedAt: null };
}

/** (Re)read the local snapshot and publish it as the overlay. Local file only,
 *  never the network. Tests call it to simulate a restart. */
export function loadModelCatalogSnapshot(): void {
	const { snapshot, checkedAt } = readSnapshot();
	const state = catalogGlobal[STATE_KEY];
	if (state) Object.assign(state, { snapshot, checkedAt });
	else catalogGlobal[STATE_KEY] = { snapshot, checkedAt, attemptedAt: 0 };
	setModelCatalogOverlay(snapshot);
}

/** Once per process (the composition root calls it at load). */
export function initializeModelCatalog(): State {
	if (!catalogGlobal[STATE_KEY]) loadModelCatalogSnapshot();
	return catalogGlobal[STATE_KEY]!;
}

/** When the shared snapshot last checked pi.dev (ISO), or null. */
export function modelCatalogCheckedAt(): string | null {
	return initializeModelCatalog().checkedAt;
}

async function fetchShard(provider: string, signal: AbortSignal): Promise<Model<Api>[]> {
	const url = new URL(`${PI_CATALOG_ORIGIN}/api/models/providers/${encodeURIComponent(provider)}?types=chat`);
	const response = await fetch(url, {
		cache: "no-store", credentials: "omit", redirect: "error", signal,
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		await response.body?.cancel();
		// The SDK's unsupported-shard statuses, not a deletion.
		if (response.status === 404 || response.status === 501) return [];
		throw new Error("pi.dev catalog request failed");
	}
	return checkedModels(provider, catalogRows(await readBoundedJson(response, MAX_SHARD_BYTES)));
}

/** The providers a refresh asks pi.dev about: builtin key providers with a
 *  bundled catalog whose instance key is present (keys are instance-wide,
 *  admin-managed; the same env-first presence the picker federates on). */
export function refreshProviders(): string[] {
	const catalogs = builtins();
	return AUTH_PROVIDER_KEYS.map(({ id }) => id).filter((provider) => catalogs.has(provider) && providerKeyPresent(provider));
}

async function refresh(state: State): Promise<ModelCatalogRefreshOutcome> {
	const configured = refreshProviders();
	if (!configured.length) return "no-providers";
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	try {
		const shards = await Promise.all(configured.map(async (provider) => [provider, await fetchShard(provider, signal)] as const));
		signal.throwIfAborted();
		const snapshot: Catalog = new Map(state.snapshot);
		for (const [provider, models] of shards) {
			if (!models.length) continue;
			// Keep previously imported ids if a later feed omits them: saved
			// slots, chats and policies can still name them.
			const merged = new Map(snapshot.get(provider)?.map((model) => [model.id, model]));
			for (const model of models) {
				const previous = merged.get(model.id);
				if (!previous || (previous.api === model.api && previous.baseUrl === model.baseUrl)) merged.set(model.id, model);
			}
			if (merged.size > MAX_SHARD_ROWS) throw new Error("Model catalog exceeds the row limit");
			snapshot.set(provider, [...merged.values()]);
		}
		const providers = (value: Catalog) => JSON.stringify(Object.fromEntries(value));
		const changed = providers(snapshot) !== providers(state.snapshot);
		const checkedAt = new Date().toISOString();
		const text = JSON.stringify({ version: 1, checkedAt, providers: Object.fromEntries(snapshot) });
		if (Buffer.byteLength(text) > MAX_MODEL_CATALOG_BYTES) throw new Error("Model catalog exceeds the snapshot limit");
		stores.modelCatalogStore.writeSnapshot(text);
		state.checkedAt = checkedAt;
		if (!changed) return "unchanged";
		state.snapshot = snapshot;
		setModelCatalogOverlay(snapshot);
		return "updated";
	} finally { controller.abort(); }
}

/** One refresh; concurrent callers (the button, the daily timer) share it.
 *  Throws on any failure, with nothing published. */
export function refreshModelCatalog(): Promise<ModelCatalogRefreshOutcome> {
	const state = initializeModelCatalog();
	return state.refreshing ??= refresh(state).finally(() => {
		state.refreshing = undefined;
		state.attemptedAt = Date.now();
	});
}

/** The daily tick: reads the switch fresh, never throws (a side channel). */
export async function runScheduledModelRefresh(): Promise<ModelCatalogRefreshOutcome | "off" | "failed"> {
	try {
		if (!modelCatalogAutoRefresh()) return "off";
		return await refreshModelCatalog();
	} catch (err) {
		console.warn(`[model-catalog] daily refresh failed: ${err instanceof Error ? err.message : err}`);
		return "failed";
	}
}

/** Delay until the next automatic refresh: a day after the later of the last
 *  successful check and the last attempt, never sooner than BOOT_DELAY_MS. */
export function nextRefreshDelay(checkedAt: string | null, attemptedAt: number, now = Date.now()): number {
	const last = Math.max(checkedAt ? Date.parse(checkedAt) : 0, attemptedAt);
	return Math.min(DAY_MS, Math.max(BOOT_DELAY_MS, last + DAY_MS - now));
}

/** Arm the daily refresh: once per process, in the Next server only (never in
 *  tests, CLI scripts or `next build`). The timer is unref'd and never blocks
 *  startup; each tick re-arms itself. */
export function startModelCatalogSchedule(): void {
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build") return;
	const state = initializeModelCatalog();
	if (state.timer) return;
	const arm = () => {
		state.timer = setTimeout(() => {
			void runScheduledModelRefresh().finally(arm);
		}, nextRefreshDelay(state.checkedAt, state.attemptedAt));
		state.timer.unref?.();
	};
	arm();
}
