/**
 * Admin policy and per-user usage API logic (multi-user design §10). The
 * routes stay transport; this is the composition: validate, persist, and fold
 * every tenant's month. A corrupt admin.json maps to 500 admin_policy_corrupt.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../../config.ts";
import { AdminPolicyCorrupt } from "../core/contracts/admin.ts";
import { LOCAL_TENANT, TENANT_ID_RE, multiUser, runAsTenant } from "../core/tenant-context.ts";
import { monthKey } from "../core/usage.ts";
import { keycloakAdmin } from "./keycloak-admin.ts";
import { spentThisMonth } from "./model-gate.ts";
import { currentPolicy, setDefaults, setUserPolicy, validatePolicy } from "./policy.ts";

const corrupt = () => Response.json({ error: "admin_policy_corrupt" }, { status: 500 });
const invalid = (detail: string) => Response.json({ error: "invalid_policy", detail }, { status: 400 });

/** Maps AdminPolicyCorrupt to its 500; anything else propagates. */
async function guarded(fn: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof AdminPolicyCorrupt) return corrupt();
		throw e;
	}
}

export function adminPolicyView(): Promise<Response> {
	return guarded(() => {
		const p = currentPolicy();
		return Response.json({ defaults: p.newUserDefaults, users: p.users });
	});
}

export function putDefaultsPolicy(raw: unknown): Promise<Response> {
	return guarded(() => {
		const v = validatePolicy(raw);
		if (!v.ok) return invalid(v.error);
		setDefaults(v.policy);
		return new Response(null, { status: 204 });
	});
}

/** `{useDefaults:true}` removes the user's override. */
export function putUserPolicy(userId: string, raw: unknown): Promise<Response> {
	return guarded(() => {
		if (!TENANT_ID_RE.test(userId)) return Response.json({ error: "invalid_user" }, { status: 400 });
		if (raw && typeof raw === "object" && (raw as { useDefaults?: unknown }).useDefaults === true) {
			setUserPolicy(userId, null);
			return new Response(null, { status: 204 });
		}
		const v = validatePolicy(raw);
		if (!v.ok) return invalid(v.error);
		setUserPolicy(userId, v.policy);
		return new Response(null, { status: 204 });
	});
}

/** Tenant ids with data: directories of <data>/users/ (multi-user), else the local tenant. */
function tenantIds(): string[] {
	if (!multiUser()) return [LOCAL_TENANT.id];
	try {
		return fs
			.readdirSync(path.join(DATA_ROOT, "users"), { withFileTypes: true })
			.filter((e) => e.isDirectory() && TENANT_ID_RE.test(e.name))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** Keycloak admin ids, or null when unknown (not configured or Keycloak failed). */
async function adminIds(): Promise<Set<string> | null> {
	try {
		const kc = keycloakAdmin();
		if (!kc) return null;
		return new Set((await kc.listUsers()).filter((u) => u.isAdmin).map((u) => u.id));
	} catch {
		return null;
	}
}

export function adminUsage(): Promise<Response> {
	return guarded(async () => {
		const policy = currentPolicy();
		const admins = await adminIds();
		const users = tenantIds().map((id) => {
			const tenant = id === LOCAL_TENANT.id ? LOCAL_TENANT : { id, name: id, isAdmin: false };
			const { usd, unpriced } = runAsTenant(tenant, () => spentThisMonth());
			const cap = (policy.users[id] ?? policy.newUserDefaults)?.monthlyCapUsd ?? null;
			return { userId: id, spentUsd: usd, unpricedCalls: unpriced, capUsd: cap, restricted: admins ? !admins.has(id) : true };
		});
		return Response.json({ month: monthKey(new Date()), users });
	});
}
