/** Custom endpoint route harness. Import it only AFTER the suite has pointed
 * LH_DATA_DIR / LH_AUTH_FILE at its scratch dir (config.ts binds at load). */
import { randomBytes } from "node:crypto";
import * as route from "../../app/api/custom-provider/route.ts";
import { authStore } from "../../src/store/auth.ts";
import { customProviderStore } from "../../src/store/custom-provider.ts";
import type { CustomProviderConfig } from "../../src/core/contracts/custom-provider.ts";

export const ADMIN = "11111111-1111-4111-8111-111111111111";
export const USER = "22222222-2222-4222-8222-222222222222";
export const BASE = "http://192.0.2.10:11434/v1";
const URL_ = "http://localhost/api/custom-provider";

export function headers(admin = true, extra: Record<string, string> = {}): Record<string, string> {
	return {
		"x-auth-request-user": admin ? ADMIN : USER,
		"x-auth-request-groups": admin ? "/learnharness,/learnharness-admin" : "/learnharness",
		origin: "http://localhost",
		host: "localhost",
		"content-type": "application/json",
		...extra,
	};
}

export const get = (admin = true) => route.GET(new Request(URL_, { headers: headers(admin) }));
export const etag = async () => (await get()).headers.get("etag")!;

type Method = "POST" | "PATCH" | "DELETE";
export async function mutate(method: Method, body: unknown, extra: Record<string, string> = {}, admin = true): Promise<Response> {
	const init: RequestInit = { method, headers: headers(admin, { "if-match": await etag(), ...extra }) };
	if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
	return route[method](new Request(URL_, init));
}
export const post = (body: unknown, extra?: Record<string, string>) => mutate("POST", body, extra);

/** A committed, authorized endpoint written straight through the stores. */
export function seed(partial: Partial<CustomProviderConfig> = {}, key?: string): CustomProviderConfig {
	const bindingId = randomBytes(16).toString("hex");
	const config: CustomProviderConfig = { version: 1, baseUrl: BASE, mode: key ? "key" : "keyless", pricing: "free", bindingId, snapshot: [{ id: "m" }], ...partial };
	authStore.writeCustomAuth({ version: 1, id: config.bindingId, baseUrl: config.baseUrl, mode: config.mode }, key);
	customProviderStore.writeConfig(config);
	return config;
}

export { route };
