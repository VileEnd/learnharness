/**
 * Per-user model and cap policy resolution (multi-user design §10). The
 * file (admin.json) holds explicit policy; absent, built-in defaults derive
 * from the live catalog's "Cheapest" recommended models.
 */

import { AdminPolicyCorrupt, DEFAULT_MONTHLY_CAP_USD, DENY_ALL_POLICY, modelKey, type AdminPolicy, type PolicyModel, type UserPolicy } from "../core/contracts/admin.ts";
import { recommendedFor } from "../core/recommended-models.ts";
import { multiUser, requireTenant } from "../core/tenant-context.ts";
import { catalogModels } from "./model-catalog.ts";
import { stores } from "./stores.ts";

export interface CatalogModelLike {
	provider: string;
	id: string;
	input?: readonly string[];
}

const pick = (m: CatalogModelLike): PolicyModel => ({ provider: m.provider, id: m.id });

/** Pure: built-in defaults from the catalog's available "Cheapest" entries. */
export function builtInDefaults(models: readonly CatalogModelLike[]): UserPolicy {
	const cheapest = recommendedFor(models)
		.filter((r) => r.entry.badge === "Cheapest")
		.map((r) => r.model);
	const first = cheapest[0];
	const vision = cheapest.find((m) => m.input?.includes("image"));
	return {
		slots: {
			...(first ? { strong: pick(first), cheap: pick(first) } : {}),
			...(vision ? { vision: pick(vision) } : {}),
		},
		allowedModels: cheapest.map((m) => modelKey(m)),
		monthlyCapUsd: DEFAULT_MONTHLY_CAP_USD,
	};
}

/** The stored file, or an empty one. Throws AdminPolicyCorrupt on a corrupt file. */
function stored(): AdminPolicy {
	return stores.adminPolicyStore.readPolicy() ?? { version: 1, users: {} };
}

/** The admin's view: newUserDefaults is filled from the live catalog when not persisted. May throw AdminPolicyCorrupt. */
export function currentPolicy(): AdminPolicy {
	const p = stored();
	return { ...p, newUserDefaults: p.newUserDefaults ?? builtInDefaults(catalogModels()) };
}

/** Enforcement read: FAILS CLOSED (deny-all) when the policy file is corrupt. */
export function policyFor(userId: string): UserPolicy {
	try {
		const p = stored();
		return p.users[userId] ?? p.newUserDefaults ?? builtInDefaults(catalogModels());
	} catch (e) {
		if (!(e instanceof AdminPolicyCorrupt)) throw e;
		console.error("policyFor: admin.json is corrupt; denying all models and spend");
		return DENY_ALL_POLICY;
	}
}

/** The ambient tenant's policy when restricted (multi-user AND non-admin), else null. Throws NoTenantError in multi-user mode with no tenant. */
export function restrictedPolicy(): UserPolicy | null {
	if (!multiUser()) return null;
	const t = requireTenant();
	if (t.isAdmin) return null;
	return policyFor(t.id);
}

/** Refuses (throws AdminPolicyCorrupt) on a corrupt file; never persists newUserDefaults. */
export function setUserPolicy(userId: string, p: UserPolicy | null): void {
	const cur = stored();
	const users = { ...cur.users };
	if (p) users[userId] = p;
	else delete users[userId];
	stores.adminPolicyStore.writePolicy({ ...cur, users });
}

export function setDefaults(p: UserPolicy): void {
	stores.adminPolicyStore.writePolicy({ ...stored(), newUserDefaults: p });
}

export type PolicyValidation = { ok: true; policy: UserPolicy } | { ok: false; error: string };

const isModel = (v: unknown): v is PolicyModel =>
	!!v && typeof v === "object" && typeof (v as PolicyModel).provider === "string" && typeof (v as PolicyModel).id === "string";

export function validatePolicy(raw: unknown, models: readonly CatalogModelLike[] = catalogModels()): PolicyValidation {
	if (!raw || typeof raw !== "object") return { ok: false, error: "policy must be an object" };
	const r = raw as Partial<UserPolicy>;
	const known = new Set(models.map((m) => modelKey(m)));
	const slots: UserPolicy["slots"] = {};
	const rs = (r.slots ?? {}) as Record<string, unknown>;
	for (const name of ["strong", "cheap", "vision"] as const) {
		const m = rs[name];
		if (m === undefined || m === null) continue;
		if (!isModel(m)) return { ok: false, error: `slot ${name} is malformed` };
		if (!known.has(modelKey(m))) return { ok: false, error: `unknown model ${modelKey(m)} in slot ${name}` };
		slots[name] = { provider: m.provider, id: m.id };
	}
	if (!Array.isArray(r.allowedModels) || !r.allowedModels.every((k) => typeof k === "string")) {
		return { ok: false, error: "allowedModels must be a list of provider:id strings" };
	}
	const allowedModels = [...new Set(r.allowedModels)];
	for (const k of allowedModels) if (!known.has(k)) return { ok: false, error: `unknown model ${k}` };
	const cap = r.monthlyCapUsd;
	if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0)) {
		return { ok: false, error: "monthlyCapUsd must be null or a finite number >= 0" };
	}
	return { ok: true, policy: { slots, allowedModels, monthlyCapUsd: cap } };
}
