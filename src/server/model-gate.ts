/**
 * Per-user models and monthly caps, enforced (multi-user design §10). One
 * gate on every engine (installed into src/agent/models.ts piEngineForSpec by
 * the composition root, src/server/stores.ts), the up-front cap check the
 * turn and the paid side channels call, the settings overlay every settings
 * read goes through, and the write-side model check. Admins and single-user
 * mode are never gated (restrictedPolicy() is null for them).
 */

import type { ModelRole } from "../../config.ts";
import type { EngineOptions, ResolvedModelSpec } from "../agent/models.ts";
import { allowedSet, DENY_ALL_POLICY, modelKey, type PolicyModel, type UserPolicy } from "../core/contracts/admin.ts";
import { requireTenant } from "../core/tenant-context.ts";
import { monthKey } from "../core/usage.ts";
import {
	MODEL_SLOTS,
	ModelNotAllowedError,
	MonthlyCapReachedError,
	PolicyUnavailableError,
	ROLE_SLOT,
	modelNotAllowed,
	slotsConfigured,
	type ModelNotAllowed,
	type ModelSlotName,
	type ModelsSettings,
	type UserSettings,
} from "../core/settings.ts";
import { isCustomKey, isUnpricedCustomKey, pricedCustomKeys } from "./custom-provider.ts";
import { restrictedPolicy } from "./policy.ts";
import { stores } from "./stores.ts";
import { monthSpend } from "./usage.ts";

interface SpendCacheEntry {
	month: string;
	stamp: string | null;
	usd: number;
	unpriced: number;
}

// Per tenant id, keyed on the month file's size and mtime: the cap check runs
// on every LLM call, so an unchanged log is never folded twice. On globalThis
// like the other registries (Next may load this module once per bundle).
const g = globalThis as { __lhSpendCache?: Map<string, SpendCacheEntry> };
const spendCache = (g.__lhSpendCache ??= new Map<string, SpendCacheEntry>());

/** This month's spend for the ambient tenant: the priced total (unpriced
 *  calls count 0 toward the cap) and how many calls had no price. */
export function spentThisMonth(): { usd: number; unpriced: number } {
	const tenant = requireTenant().id;
	const month = monthKey(new Date());
	// Stamp BEFORE the fold: a line appended meanwhile makes the next call miss.
	const stamp = stores.requestLog.monthStamp(month);
	const hit = spendCache.get(tenant);
	if (hit && hit.month === month && hit.stamp === stamp) return { usd: hit.usd, unpriced: hit.unpriced };
	const { usd, unpriced } = monthSpend(month);
	spendCache.set(tenant, { month, stamp, usd, unpriced });
	return { usd, unpriced };
}

function assertPolicyCap(policy: UserPolicy): void {
	// The fail-closed policy (corrupt admin.json) is not a spending limit.
	if (policy === DENY_ALL_POLICY) throw new PolicyUnavailableError();
	if (policy.monthlyCapUsd === null) return;
	const { usd } = spentThisMonth();
	if (usd >= policy.monthlyCapUsd) throw new MonthlyCapReachedError(policy.monthlyCapUsd, usd);
}

/** Throws MonthlyCapReachedError when a restricted user is at or over their cap. */
export function assertWithinCap(): void {
	const policy = restrictedPolicy();
	if (policy) assertPolicyCap(policy);
}

/** The per-turn spend ceiling: the configured one, clamped for a capped
 *  restricted user to what is left of their month (never below 0). */
export function turnSpendCapFor(configuredUsd: number): number {
	const policy = restrictedPolicy();
	if (!policy || policy.monthlyCapUsd === null) return configuredUsd;
	return Math.min(configuredUsd, Math.max(0, policy.monthlyCapUsd - spentThisMonth().usd));
}

// One "skipped" line per tenant, month and channel (the index ticks every minute).
const g2 = globalThis as { __lhCapSkipLogged?: Set<string> };
const capSkipLogged = (g2.__lhCapSkipLogged ??= new Set<string>());

/** For the paid side channels (embeddings): false when the ambient user is
 *  over the cap, so their work is skipped; logged once per month. */
export function capAllows(what: string): boolean {
	try {
		assertWithinCap();
		return true;
	} catch (err) {
		if (!(err instanceof MonthlyCapReachedError)) throw err;
		const key = `${requireTenant().id}:${monthKey(new Date())}:${what}`;
		if (!capSkipLogged.has(key)) {
			capSkipLogged.add(key);
			console.info(`[policy] ${what} skipped - monthly cap reached ($${err.envelope.spentUsd.toFixed(2)} of $${err.envelope.capUsd})`);
		}
		return false;
	}
}

/** The models a restricted user may run: allowedModels ∪ slots, minus, for a
 *  capped user, every custom model without a price (a paid endpoint's model
 *  without rates). An unpriced call counts $0 toward the cap, so it would
 *  bypass it (upstream port 6). The custom config is read only when the set
 *  names a custom model. */
export function effectiveAllowed(policy: UserPolicy): Set<string> {
	const allowed = allowedSet(policy);
	if (policy.monthlyCapUsd === null) return allowed;
	let priced: Set<string> | undefined;
	for (const key of allowed) {
		if (!isCustomKey(key)) continue;
		priced ??= pricedCustomKeys();
		if (isUnpricedCustomKey(key, priced)) allowed.delete(key);
	}
	return allowed;
}

const isRole = (purpose: string | undefined): purpose is ModelRole => purpose !== undefined && Object.hasOwn(ROLE_SLOT, purpose);

/** The slot tier an engine draws from: its role's tier; a conversation turn,
 *  compaction or any other non-role purpose runs on strong. */
export function tierOf(opts: Pick<EngineOptions, "role" | "purpose">): ModelSlotName {
	const role = opts.role ?? (isRole(opts.purpose) ? opts.purpose : undefined);
	return role ? ROLE_SLOT[role] : "strong";
}

/** The spec a restricted user may run: the request when allowed, else its
 *  tier's policy slot (keeping the requested thinking level, which the engine
 *  clamps), else ModelNotAllowedError. */
function allowedSpec(policy: UserPolicy, spec: ResolvedModelSpec, tier: ModelSlotName): ResolvedModelSpec {
	const allowed = effectiveAllowed(policy);
	if (allowed.has(modelKey(spec))) return spec;
	const slot = policy.slots[tier];
	// A slot the effective set excludes (an unpriced custom model for a capped user) is no fallback.
	if (!slot || !allowed.has(modelKey(slot))) throw new ModelNotAllowedError(modelKey(spec));
	return { provider: slot.provider, id: slot.id, ...(spec.thinkingLevel !== undefined && { thinkingLevel: spec.thinkingLevel }) };
}

/** THE gate (installed by stores.ts): the cap first, then the model. */
export function modelGate(spec: ResolvedModelSpec, opts: EngineOptions): ResolvedModelSpec {
	const policy = restrictedPolicy();
	if (!policy) return spec;
	assertPolicyCap(policy);
	return allowedSpec(policy, spec, tierOf(opts));
}

/** A settings record as a restricted user reads it. Each slot that is
 *  missing or names a disallowed model shows the policy slot instead (unset
 *  when the policy has none, or when its model is outside the effective set).
 *  Never written to disk. Reads only the custom endpoint's pricing. */
export function overlaySettings(record: UserSettings | null, policy: UserPolicy | null): UserSettings | null {
	if (!policy) return record;
	const allowed = effectiveAllowed(policy);
	const models: ModelsSettings = { ...record?.models };
	let changed = false;
	for (const name of MODEL_SLOTS) {
		const mine = models[name];
		if (mine?.model && allowed.has(modelKey(mine.model))) continue;
		const slot: PolicyModel | undefined = policy.slots[name];
		if (slot && allowed.has(modelKey(slot))) {
			models[name] = {
				model: { provider: slot.provider, id: slot.id },
				...(mine?.thinkingLevel !== undefined && { thinkingLevel: mine.thinkingLevel }),
			};
			changed = true;
		} else if (mine) {
			delete models[name];
			changed = true;
		}
	}
	// Nothing to lay over: the record as stored (null stays null, first boot).
	if (!changed) return record;
	return { ...(record ?? { version: 1 }), models };
}

/** THE settings read: the stored record with the ambient user's policy laid
 *  over its model slots. Every resolution path reads through this. */
export function readSettingsView(): UserSettings | null {
	return overlaySettings(stores.settingsStore.readSettings(), restrictedPolicy());
}

/** The first-run gate's truth (the setup CTA and dialog): every slot set.
 *  A restricted user needs only the slots their policy defines, since they
 *  cannot pick any other model; a slot the admin left unset refuses
 *  honestly where it is needed, never through the setup flow. */
export function modelsConfigured(): boolean {
	const policy = restrictedPolicy();
	const view = overlaySettings(stores.settingsStore.readSettings(), policy);
	if (!policy) return slotsConfigured(view?.models);
	// A policy slot outside the effective set counts as unset: it refuses at
	// the turn (unconfiguredTierRefusal), never through the setup flow.
	const allowed = effectiveAllowed(policy);
	return MODEL_SLOTS.every((name) => {
		const slot = policy.slots[name];
		return !slot || !allowed.has(modelKey(slot)) || Boolean(view?.models?.[name]?.model);
	});
}

/** A restricted user's refusal for a tier that resolves to no model at all
 *  (their policy leaves that slot unset): the 403 model refusal, since the
 *  setup flow cannot fix it. `model` names the user's own stored pick for
 *  the tier when there is one (the overlay hid it as disallowed), else "".
 *  Null for admins and in single-user mode (the 503 setup path stays). */
export function unconfiguredTierRefusal(tier: ModelSlotName): ModelNotAllowed | null {
	if (!restrictedPolicy()) return null;
	const mine = stores.settingsStore.readSettings()?.models?.[tier]?.model;
	return modelNotAllowed(mine ? modelKey(mine) : "");
}

/** The write-side check: the first model a restricted user may not pick, as
 *  the 403 envelope, else null. */
export function disallowedModel(models: readonly (PolicyModel | undefined)[]): ModelNotAllowed | null {
	const policy = restrictedPolicy();
	if (!policy) return null;
	const allowed = effectiveAllowed(policy);
	const bad = models.find((m): m is PolicyModel => m !== undefined && !allowed.has(modelKey(m)));
	return bad ? modelNotAllowed(modelKey(bad)) : null;
}

/** The catalog filter: a restricted user sees only their allowed models. */
export function allowedModelsOnly<T extends PolicyModel>(models: readonly T[]): T[] {
	const policy = restrictedPolicy();
	if (!policy) return [...models];
	const allowed = effectiveAllowed(policy);
	return models.filter((m) => allowed.has(modelKey(m)));
}
