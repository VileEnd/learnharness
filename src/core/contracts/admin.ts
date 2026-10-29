/**
 * Per-user model and spending-cap policy (multi-user design §10).
 * Browser-safe: types and pure helpers only. Persisted in
 * <globalDataRoot()>/admin.json by the AdminPolicyStore.
 */

export interface PolicyModel {
	provider: string;
	id: string;
}

export interface UserPolicy {
	slots: { strong?: PolicyModel; cheap?: PolicyModel; vision?: PolicyModel };
	/** "provider:id" keys. */
	allowedModels: string[];
	/** Monthly USD cap; null = uncapped. */
	monthlyCapUsd: number | null;
}

export interface AdminPolicy {
	version: 1;
	newUserDefaults: UserPolicy;
	users: Record<string, UserPolicy>;
}

export const DEFAULT_MONTHLY_CAP_USD = 5;

export function modelKey(m: PolicyModel): string {
	return `${m.provider}:${m.id}`;
}

/** allowedModels ∪ the slot models, as "provider:id" keys. */
export function allowedSet(policy: UserPolicy): Set<string> {
	const out = new Set<string>(policy.allowedModels);
	for (const m of Object.values(policy.slots)) if (m) out.add(modelKey(m));
	return out;
}
