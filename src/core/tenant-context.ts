/**
 * Tenant context (multi-user design §2): which user the current request,
 * job or background task acts for. Server-only (node:async_hooks) — NOT in
 * the browser-safe core barrel.
 *
 * Single-user mode (LH_MULTI_USER unset) has exactly one implicit tenant,
 * LOCAL_TENANT, and every path stays at its legacy location. In multi-user
 * mode, touching per-user state outside a runAsTenant scope throws.
 *
 * The AsyncLocalStorage lives on globalThis (the turn-liveness lesson: Next
 * dev gives each route entry its own module instances and HMR reloads
 * modules, so a module-level ALS would be a different object in each).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface Tenant {
	id: string;
	name: string;
	isAdmin: boolean;
}

export const LOCAL_TENANT: Tenant = { id: "local", name: "local", isAdmin: true };

/** Valid tenant ids (twin in scripts/migrate-to-tenants.mjs). */
export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class NoTenantError extends Error {
	constructor() {
		super("NoTenantError: no tenant in scope (multi-user mode requires runAsTenant)");
		this.name = "NoTenantError";
	}
}

type LhTenantGlobal = { __lhTenantAls?: AsyncLocalStorage<Tenant> };

function als(): AsyncLocalStorage<Tenant> {
	const g = globalThis as typeof globalThis & LhTenantGlobal;
	return (g.__lhTenantAls ??= new AsyncLocalStorage<Tenant>());
}

/** Read at call time so tests can toggle it. */
export function multiUser(): boolean {
	return process.env.LH_MULTI_USER === "1";
}

export function runAsTenant<T>(tenant: Tenant, fn: () => T): T {
	// Defense in depth: a bad id must never reach a path join.
	if (tenant.id !== LOCAL_TENANT.id && !TENANT_ID_RE.test(tenant.id)) {
		throw new Error(`runAsTenant: invalid tenant id ${JSON.stringify(tenant.id)}`);
	}
	return als().run(tenant, fn);
}

/** The tenant of the current scope, if any. */
export function currentTenant(): Tenant | undefined {
	return als().getStore();
}

/** The scope's tenant; LOCAL_TENANT in single-user mode; throws in multi-user mode outside a scope. */
export function requireTenant(): Tenant {
	const t = currentTenant();
	if (t) return t;
	if (!multiUser()) return LOCAL_TENANT;
	throw new NoTenantError();
}

/** A tenant-namespaced key for process-wide registries. */
export function tenantKey(id: string): string {
	return `${requireTenant().id}:${id}`;
}

/**
 * The key for a process-wide registry entry: tenant-namespaced in multi-user
 * mode, the bare id in single-user mode (one tenant, so no collisions, and
 * the legacy key shape stays what single-user tooling and tests expect).
 */
export function registryKey(id: string): string {
	return multiUser() ? tenantKey(id) : id;
}
