/** Read-time API-dollar estimates. Pi owns both rates and arithmetic.
 * Catalog resolution is key-independent; no provider dispatch/auth is needed.
 * Never mutate saved native messages: calculateCost mutates its usage.cost.
 * The admin's custom endpoint (upstream port 6) is priced from its own
 * config, never its pi entry: free = $0 (the one sanctioned real zero), paid
 * = the admin's per-model rates, paid without rates = unpriced (null).
 * Claude Code is never priced (null): the CLI's own login decides charges,
 * and its pi entry's zeros are placeholders.
 * Known gap: chat turns and jobs store no dollars, so their custom calls are
 * priced from the CURRENT config (display only; the cap reads the log stamp).
 */
import { calculateCost, type Model, type Api, type Models, type Usage } from "@earendil-works/pi-ai";
import { piModels } from "../agent/models.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "../core/contracts.ts";
import { sessionCost as foldSessionCost, turnCost as foldTurnCost, jobCost as foldJobCost, type CallPricer } from "../core/prices.ts";
import { customModelCost, customProviderConfig, type CustomModelCost, type CustomProviderRuntime } from "./custom-provider.ts";

/** "provider:id" split on the FIRST colon: ids may contain one (Ollama `qwen3:8b`). */
function split(id: string): { provider: string; model: string } | undefined {
	const colon = id.indexOf(":");
	return colon < 0 ? undefined : { provider: id.slice(0, colon), model: id.slice(colon + 1) };
}

/** A built-in catalog model. The custom endpoint and Claude Code are never
 *  read here: their pi entries carry zero placeholders (customModelCost
 *  decides the custom price; Claude Code is unpriced). */
function catalogModel(id: string, models: Models = piModels()) {
	const parts = split(id);
	if (!parts || parts.provider === CUSTOM_PROVIDER.id || parts.provider === CLAUDE_CODE_PROVIDER) return undefined;
	return models.getModel(parts.provider, parts.model);
}

/** Tokens → dollars against one rate card; null for impossible usage. */
function priceWith(cost: Model<Api>["cost"], call: Partial<CallUsage>, legacyCacheGuard: boolean): number | null {
	if (call.inputTokens === undefined || call.outputTokens === undefined) return null;
	const input = call.inputTokens;
	const output = call.outputTokens;
	const cacheRead = call.cacheReadTokens ?? 0;
	const cacheWrite = call.cacheWriteTokens ?? 0;
	const cacheWrite1h = call.cacheWrite1hTokens ?? 0;
	if ([input, output, cacheRead, cacheWrite, cacheWrite1h].some((v) => !Number.isFinite(v) || v < 0) || cacheWrite1h > cacheWrite) return null;
	// Old records discarded this split. Only price them if it cannot affect
	// the result; do not invent short-retention precision from a missing field.
	if (legacyCacheGuard && cacheWrite > 0 && call.cacheWrite1hTokens === undefined &&
		[cost, ...(cost.tiers ?? [])].some((rate) => rate.cacheWrite !== 2 * rate.input)) return null;
	const usage: Usage = {
		input, output, cacheRead, cacheWrite, cacheWrite1h,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const total = calculateCost({ cost } as Model<Api>, usage).total;
	return Number.isFinite(total) && total >= 0 ? total : null;
}

/** A pricer bound to one read of the catalog and the custom endpoint: a fold
 *  over many lines (the month view, the cap check) reads the config once.
 *  Custom: free = $0, paid = the admin's rates, no rates = unpriced (null).
 *
 *  `customFromConfig: false` is the request-log fold (usage page, cap): a
 *  priced custom call already carries its call-time providerCostUsd, so a
 *  custom line without one is unpriced for good, whatever the config says
 *  now. The default (true) serves the chat and job views: persisted turns
 *  and jobs carry no dollars, so their custom calls are priced from the
 *  CURRENT config (display only; see docs/architecture.md). */
export function createPricer({ customFromConfig = true }: { customFromConfig?: boolean } = {}): CallPricer {
	const models = piModels();
	let runtime: CustomProviderRuntime | null | undefined;
	const custom = (id: string): CustomModelCost | null => customModelCost((runtime ??= customProviderConfig()), id);
	return (call, modelId) => {
		const parts = split(modelId);
		if (parts?.provider === CLAUDE_CODE_PROVIDER) return null;
		if (parts?.provider === CUSTOM_PROVIDER.id) {
			if (!customFromConfig) return null;
			const cost = custom(parts.model);
			return cost ? priceWith(cost, call, false) : null;
		}
		const model = catalogModel(modelId, models);
		return model ? priceWith(model.cost, call, true) : null;
	};
}

export function callCost(call: Partial<CallUsage>, modelId: string): number | null {
	return createPricer()(call, modelId);
}

export function turnCost(turn: TurnUsage): number | null {
	return foldTurnCost(turn, createPricer());
}
export function sessionCost(record: Pick<ChatRecord, "turns">) {
	return foldSessionCost(record, createPricer());
}
export function jobCost(job: Pick<JobRecord, "usage">): number | null {
	const usage = job.usage;
	if (!usage || usage.steps < 1) return null;
	const hasCalls = usage.calls?.length === usage.steps;
	if (!hasCalls && usage.steps > 1 && catalogModel(usage.model)?.cost.tiers?.length) return null;
	return foldJobCost(job, createPricer());
}
