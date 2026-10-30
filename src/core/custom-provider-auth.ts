/**
 * The custom endpoint's key binding (upstream 870a1ad/dbf8080, simplified for
 * the fork): a reserved auth-file entry ties the stored key to the exact base
 * URL, mode and a random nonce that custom-provider.json must also carry. A
 * key is used only when all three match, so a key is never sent to a URL the
 * admin did not enter it for, and any half-committed pair fails closed.
 * Never a credential hash; nothing here derives from the key.
 */
import { normalizeBaseUrl, type CustomProviderConfig, type CustomProviderMode } from "./contracts/custom-provider.ts";

/** The reserved auth-file entry name (a JSON string value, so the flat map stays string→string). */
export const CUSTOM_AUTH_BINDING = "__learnharness_custom_provider_binding";

export interface CustomAuthBinding {
	version: 1;
	id: string;
	baseUrl: string;
	mode: CustomProviderMode;
}

/** The binding from its stored JSON string, or undefined for anything malformed. */
export function parseCustomAuthBinding(value: unknown): CustomAuthBinding | undefined {
	try {
		const b = typeof value === "string" ? (JSON.parse(value) as Record<string, unknown> | null) : undefined;
		if (!b || typeof b !== "object" || b.version !== 1) return;
		if (typeof b.id !== "string" || !/^[a-f0-9]{32}$/.test(b.id)) return;
		if (b.mode !== "keyless" && b.mode !== "key") return;
		if (typeof b.baseUrl !== "string" || !b.baseUrl || normalizeBaseUrl(b.baseUrl) !== b.baseUrl) return;
		return { version: 1, id: b.id, baseUrl: b.baseUrl, mode: b.mode };
	} catch {
		return;
	}
}

/** Does the auth file's binding authorize this config (nonce, URL and mode all equal)? */
export function customBindingMatches(config: CustomProviderConfig | null | undefined, binding: CustomAuthBinding | undefined): boolean {
	return Boolean(config && binding && config.bindingId === binding.id && config.baseUrl === binding.baseUrl && config.mode === binding.mode);
}
