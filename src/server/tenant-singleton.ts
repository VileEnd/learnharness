/**
 * A per-tenant process singleton (multi-user design §2): the exported value
 * keeps its name and type, but every property access resolves the CURRENT
 * tenant's instance (one per tenant id, built lazily by `make`). In
 * single-user mode that is LOCAL_TENANT, i.e. exactly one instance.
 *
 * The instance Map lives on globalThis[globalKey]: dev HMR and per-route
 * module copies must share it (the turn-liveness lesson).
 */
import { requireTenant } from "../core/tenant-context.ts";

export function tenantSingleton<T extends object>(globalKey: string, make: () => T): T {
	const g = globalThis as unknown as Record<string, Map<string, T> | undefined>;
	const instance = (): T => {
		const map = (g[globalKey] ??= new Map<string, T>());
		const id = requireTenant().id;
		let inst = map.get(id);
		if (!inst) {
			inst = make();
			map.set(id, inst);
		}
		return inst;
	};
	return new Proxy({} as T, {
		get(_t, prop) {
			const inst = instance();
			const value = Reflect.get(inst, prop, inst) as unknown;
			return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(inst) : value;
		},
		has: (_t, prop) => Reflect.has(instance(), prop),
		ownKeys: () => Reflect.ownKeys(instance()),
		getOwnPropertyDescriptor: (_t, prop) => {
			const d = Reflect.getOwnPropertyDescriptor(instance(), prop);
			return d ? { ...d, configurable: true } : undefined;
		},
	});
}
