import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type MutableModels,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER, isPolicyRefusal, modelNotAllowed } from "../core/settings.ts";
import { observeStream } from "./request-log.ts";
import packageMetadata from "../../package.json" with { type: "json" };

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

/** Configured providers the server syncs into the collection (upstream
 *  configureProviderSource; today the admin's one custom endpoint). The
 *  agent never reads configuration: the server injects this
 *  (src/server/stores.ts), the setModelGate precedent. */
export interface ProviderSource {
	/** Register or retire the source's providers. Runs on every piModels()
	 *  call, so it must be cheap when nothing changed. */
	sync(models: MutableModels): void;
	isCustom(providerId: string): boolean;
	/** Calls to this custom provider cost nothing (as of the last sync):
	 *  they are logged priced at a real $0, not unpriced. */
	isFree(providerId: string): boolean;
}
let providerSource: ProviderSource | undefined;

/** Install the source. A re-evaluated server module can replace it while
 *  the collection survives: retire only the previous source's providers. */
export function configureProviderSource(source: ProviderSource): void {
	if (collection && providerSource) {
		for (const provider of collection.getProviders()) {
			if (providerSource.isCustom(provider.id)) collection.deleteProvider(provider.id);
		}
	}
	providerSource = source;
}

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	providerSource?.sync(collection);
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The lowest thinking level the model supports: "off" when it can turn
 *  thinking off, else the first of getSupportedThinkingLevels (pi's
 *  ascending order). */
export function lowestThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	return supported.includes("off") ? "off" : (supported[0] ?? "off");
}

/** How an engine is built beyond its spec. `thinking: "lowest"` overrides
 *  the spec's level with the model's lowest (lowestThinkingLevel): a
 *  transcription needs no reasoning, and a reasoning reader is too slow
 *  (the drawing reader, live check 2026-10-29). */
export interface EngineOptions {
	thinking?: "lowest";
	/** Who makes the calls (request log, cost counter 2026-10-29): a
	 *  ModelRole or a turn/compaction purpose. Absent = "unlabelled". */
	purpose?: string;
	/** The chat the calls belong to, when one does (a session's spend). */
	chatId?: string;
	chatKind?: "teach" | "practice";
	/** The role the spec was resolved for, when the purpose names something
	 *  else (topicist and attribution ride the describer's role): the model
	 *  gate maps it to its slot tier. */
	role?: ModelRole;
}

/** The per-user model and cap gate (multi-user design §10): returns the spec
 *  to build (the input, or its tier's policy slot) or throws a typed policy
 *  refusal. The agent layer cannot read the policy, so the server composition
 *  injects it (src/server/stores.ts), the setRequestSink precedent. */
export type ModelGate = (spec: ResolvedModelSpec, opts: EngineOptions) => ResolvedModelSpec;

let modelGate: ModelGate | null = null;

/** Install (or clear, with null) the process-wide gate. */
export function setModelGate(next: ModelGate | null): void {
	modelGate = next;
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's; the custom endpoint resolves its own key.
 *
 *  The custom endpoint (upstream port 6) can change under a live engine (an
 *  agent loop spans many calls), so after the gate every custom call
 *  revalidates: the gate again (allow-list, pricing and cap), the model in
 *  the current collection, and thinking re-resolved from the ORIGINAL
 *  preference against current metadata (upstream 313a3c8). Its engine model
 *  is a clone permitting images, since discovery metadata is sparse; the
 *  registered capability is never promoted. */
export function piEngineForSpec(requested: ResolvedModelSpec, opts: EngineOptions = {}): PiEngine {
	// Every engine passes the gate first: the one enforcement point.
	const spec = modelGate ? modelGate(requested, opts) : requested;
	const models: Models = piModels();
	const registered = models.getModel(spec.provider, spec.id);
	if (!registered) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	const custom = providerSource?.isCustom(spec.provider) ?? false;
	const model = custom ? permitImages(registered) : registered;
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const levelFor = (m: Model<Api>): ThinkingLevel =>
		opts.thinking === "lowest"
			? lowestThinkingLevel(m)
			: spec.thinkingLevel
				? clampThinkingLevel(m, spec.thinkingLevel)
				: defaultThinkingLevel(m);
	const level = levelFor(model);
	const meta = (modelId: string) => ({
		purpose: opts.purpose ?? "unlabelled",
		chatId: opts.chatId,
		chatKind: opts.chatKind,
		provider: spec.provider,
		model: modelId,
		startedAt: Date.now(),
	});
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		// Every call is observed for the request log (one line per call,
		// beneath any retry wrapper, so a retried attempt logs too).
		streamFn: (requestModel, context, options) => {
			if (!custom) {
				return observeStream(
					models.streamSimple(requestModel, context, { ...options, reasoning: level === "off" ? undefined : level }),
					{ ...meta(requestModel.id), provider: requestModel.provider },
				);
			}
			const refusal = customRefusal(spec, opts);
			const current = piModels();
			const currentModel = current.getModel(spec.provider, spec.id);
			if (refusal || !currentModel) {
				const reason = refusal ?? "The selected custom model is unavailable.";
				return observeStream(lazyStream(requestModel, async () => { throw new Error(reason); }), meta(spec.id));
			}
			const currentLevel = levelFor(currentModel);
			const free = providerSource?.isFree(spec.provider) ?? false;
			return observeStream(
				current.streamSimple(permitImages(currentModel), context, { ...options, reasoning: currentLevel === "off" ? undefined : currentLevel }),
				{ ...meta(currentModel.id), ...(free && { providerCostUsd: 0 }) },
			);
		},
	};
}

/** A custom endpoint's owner authorizes image attempts regardless of sparse
 *  discovery metadata: a clone, never the registered model. */
function permitImages(model: Model<Api>): Model<Api> {
	return { ...model, input: ["text", "image"] };
}

/** Re-run the gate before a custom call: the refusal as the stream's error
 *  message (a policy envelope as JSON, which the chat renders with its copy),
 *  or undefined when the same model is still allowed. A substituted spec
 *  means the model is no longer allowed (an admin edit, or a pricing change
 *  that leaves a capped user on an unpriced model, mid-session). */
function customRefusal(spec: ResolvedModelSpec, opts: EngineOptions): string | undefined {
	if (!modelGate) return undefined;
	try {
		const again = modelGate(spec, opts);
		if (again.provider === spec.provider && again.id === spec.id) return undefined;
		return JSON.stringify(modelNotAllowed(`${spec.provider}:${spec.id}`));
	} catch (err) {
		if (isPolicyRefusal(err)) return JSON.stringify(err.envelope);
		return err instanceof Error ? err.message : String(err);
	}
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
