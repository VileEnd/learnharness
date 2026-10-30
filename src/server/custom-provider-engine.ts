/**
 * The custom endpoint's engine half (upstream installCustomProviderSource /
 * buildOpenAiCompatibleProvider, upstream port 6): the composition root
 * (src/server/stores.ts) installs a provider source that syncs ONE pi-ai
 * openai-completions provider, id `custom`, into the process-wide piModels()
 * collection from the GLOBAL runtime view (customProviderConfig) only, never
 * from tenant settings. Kept apart from custom-provider.ts so the install
 * never runs inside that module's import cycle with stores.ts.
 */
import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { addProviderSource } from "../agent/models.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import type { ResolvedCustomModel } from "../core/contracts/custom-provider.ts";
import { customModelCost, customProviderConfig, FREE_COST, pricedCustomKeys, type CustomProviderRuntime } from "./custom-provider.ts";

/** Placeholder bearer for a keyless endpoint (the OpenAI client needs *a* key). */
const KEYLESS_PLACEHOLDER = "not-needed";

/** One resolved custom model as a pi-ai entry: image → input, reasoning →
 *  pi's standard levels (reasoning_effort on the wire), the clamped limits.
 *  The cost is the real rate card (free zeros, or the admin's rates): pi
 *  prices each call with it and the engine stamps that on the request log.
 *  An unpriced model (paid, no rates) gets a zero placeholder that nothing
 *  reads: isPriced is false for it, so its calls carry no stamp. */
function toPiModel(runtime: CustomProviderRuntime, model: ResolvedCustomModel): Model<Api> {
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: CUSTOM_PROVIDER.id,
		baseUrl: runtime.baseUrl,
		reasoning: model.reasoning,
		input: model.image ? ["text", "image"] : ["text"],
		cost: { ...(customModelCost(runtime, model.id) ?? FREE_COST) },
		contextWindow: model.contextWindow,
		maxTokens: model.maxOutput,
		type: "chat",
	};
}

/** The pi-ai provider for one consistent runtime view. The key is resolved
 *  explicitly from that view (key mode) or is the keyless placeholder: never
 *  pi-ai's environment lookup, so CUSTOM_OPENAI_API_KEY is ignored. */
export function buildCustomProvider(runtime: CustomProviderRuntime): Provider<Api> {
	const apiKey = runtime.mode === "key" ? runtime.apiKey : undefined;
	return createProvider<Api>({
		id: CUSTOM_PROVIDER.id,
		name: CUSTOM_PROVIDER.label,
		baseUrl: runtime.baseUrl,
		auth: {
			apiKey: {
				name: `${CUSTOM_PROVIDER.label} API key`,
				resolve: async () => ({ auth: { apiKey: apiKey ?? KEYLESS_PLACEHOLDER }, source: apiKey ? "auth-file" : "keyless" }),
			},
		},
		models: runtime.models.map((m) => toPiModel(runtime, m)),
		api: openAICompletionsApi(),
	});
}

/** Install the sole custom source into the engine (src/server/stores.ts).
 *  Every piModels() call re-reads the global view; the provider is rebuilt
 *  only when that view changed (keyed on its full contents, key included,
 *  so a PATCH that keeps the bindingId still rebuilds). An operation already
 *  in flight keeps the setup it started with. */
export function installCustomProviderSource(read: () => CustomProviderRuntime | null = customProviderConfig): void {
	let fingerprint: string | undefined;
	let priced = new Set<string>();
	addProviderSource({
		id: CUSTOM_PROVIDER.id,
		isCustom: (id) => id === CUSTOM_PROVIDER.id,
		isPriced: (id, modelId) => id === CUSTOM_PROVIDER.id && priced.has(`${id}:${modelId}`),
		sync(models) {
			const runtime = read();
			const next = runtime ? JSON.stringify(runtime) : ""; // private, in memory only
			if (next === fingerprint) return;
			if (runtime) models.setProvider(buildCustomProvider(runtime));
			else models.deleteProvider(CUSTOM_PROVIDER.id);
			priced = pricedCustomKeys(runtime);
			fingerprint = next;
		},
	});
}
