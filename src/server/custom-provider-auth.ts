/**
 * The custom endpoint's credential state (upstream custom-provider-auth,
 * fork-simplified): the key is FILE-ONLY (LH_AUTH_FILE), never the
 * environment, so there is no env ownership, shadowing or reuse consent.
 * The key and its binding come from one strict read of the same record.
 */
import { customBindingMatches, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import type { CustomProviderConfig } from "../core/contracts/custom-provider.ts";
import { authStore } from "../store/auth.ts";

export interface CustomAuthState {
	/** False when the auth file is unreadable or malformed: nothing is used or written. */
	readable: boolean;
	binding?: CustomAuthBinding;
	key?: string;
}

export function customAuthState(): CustomAuthState {
	try {
		const { binding, key } = authStore.readCustomAuth();
		return { readable: true, binding, key: key?.trim() || undefined };
	} catch {
		return { readable: false };
	}
}

/** Key mode, matching binding, and a key on file: the key may go to config.baseUrl. */
export function customKeyAuthorized(config: CustomProviderConfig | null | undefined, state: CustomAuthState): boolean {
	return config?.mode === "key" && state.readable && customBindingMatches(config, state.binding) && Boolean(state.key);
}

/** Replace the key + binding pair in one atomic write. */
export function persistCustomAuth(binding: CustomAuthBinding | undefined, key: string | undefined): void {
	authStore.writeCustomAuth(binding, key);
}
