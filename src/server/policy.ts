/**
 * Per-user model and cap policy resolution (multi-user design §10). The
 * file (admin.json) holds explicit policy; absent, built-in defaults derive
 * from the live catalog's "Cheapest" recommended models.
 */

import { DEFAULT_MONTHLY_CAP_USD, modelKey, type AdminPolicy, type PolicyModel, type UserPolicy } from "../core/contracts/admin.ts";
import { recommendedFor } from "../core/recommended-models.ts";
import { currentTenant, multiUser } from "../core/tenant-context.ts";
import { modelCatalog } from "./model-catalog.ts";
import { stores } from "./stores.ts";

export interface CatalogModelLike {
	provider: string;
	id: string;
	input?: readonly string[];
}

const pick = (m: CatalogModelLike): PolicyModel => ({ provider: m.provider, id: m.id });

/** Pure: built-in defaults from the catalog's available "Cheapest" entries. */
export function builtInDefaults(catalogModels: readonly CatalogModelLike[]): UserPolicy {
	const cheapest = recommendedFor(catalogModels)
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

export function currentPolicy(): AdminPolicy {
	return (
		stores.adminPolicyStore.readPolicy() ?? {
			version: 1,
			newUserDefaults: builtInDefaults(modelCatalog().models),
			users: {},
		}
	);
}

export function policyFor(userId: string): UserPolicy {
	const p = currentPolicy();
	return p.users[userId] ?? p.newUserDefaults;
}

/** The ambient tenant's policy when restricted (multi-user AND non-admin), else null. */
export function restrictedPolicy(): UserPolicy | null {
	if (!multiUser()) return null;
	const t = currentTenant();
	if (!t || t.isAdmin) return null;
	return policyFor(t.id);
}

export function setUserPolicy(userId: string, p: UserPolicy | null): void {
	const cur = currentPolicy();
	const users = { ...cur.users };
	if (p) users[userId] = p;
	else delete users[userId];
	stores.adminPolicyStore.writePolicy({ ...cur, users });
}

export function setDefaults(p: UserPolicy): void {
	stores.adminPolicyStore.writePolicy({ ...currentPolicy(), newUserDefaults: p });
}

export type PolicyValidation = { ok: true; policy: UserPolicy } | { ok: false; error: string };

const isModel = (v: unknown): v is PolicyModel =>
	!!v && typeof v === "object" && typeof (v as PolicyModel).provider === "string" && typeof (v as PolicyModel).id === "string";

export function validatePolicy(raw: unknown, catalogModels: readonly CatalogModelLike[] = modelCatalog().models): PolicyValidation {
	if (!raw || typeof raw !== "object") return { ok: false, error: "policy must be an object" };
	const r = raw as Partial<UserPolicy>;
	const known = new Set(catalogModels.map((m) => modelKey(m)));
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
