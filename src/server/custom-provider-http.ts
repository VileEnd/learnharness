/**
 * /api/custom-provider (upstream custom-provider-http, adapted for the
 * fork's admin-managed global endpoint):
 *   GET    admin: the full status (never a key); others: {configured} only.
 *   POST   {baseUrl, mode, pricing, key?, manualModels?}: probe, then connect or edit.
 *   PATCH  {models?, pricing?}: pins and rates (the whole map), pricing. No probe.
 *   DELETE disconnect: config, key and binding removed.
 * Every mutation: requireAdmin() first (403 admin_only), then a same-origin
 * JSON request, then If-Match against the current ETag (409 stale). Errors
 * are {error: code, detail?}.
 *
 * The key is bound to URL + mode + nonce (core/custom-provider-auth.ts): a
 * different URL always needs the key re-entered, and a keyless save drops
 * the key. Commit order is auth pair FIRST, config SECOND, with best-effort
 * rollback of the whole pair, so any half-commit fails closed.
 */
import { createHmac, randomBytes } from "node:crypto";
import { currentTenant } from "../core/tenant-context.ts";
import type { CustomAuthBinding } from "../core/custom-provider-auth.ts";
import {
	CUSTOM_MODEL_LIMIT,
	CustomProviderCorrupt,
	normalizeBaseUrl,
	parseCustomModelSettings,
	parseModelIds,
	type CustomProviderConfig,
} from "../core/contracts/custom-provider.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { customAuthState, customKeyAuthorized, persistCustomAuth, type CustomAuthState } from "./custom-provider-auth.ts";
import { customProviderRuntime, discoverModels, mergeManualModels } from "./custom-provider.ts";
import { requireAdmin } from "./tenant.ts";
import { stores } from "./stores.ts";

const BODY_LIMIT = 64 * 1024;
const revisionKey = Symbol.for("lh.customProviderRevision");
const globals = globalThis as typeof globalThis & { [revisionKey]?: Buffer };
const secret = (globals[revisionKey] ??= randomBytes(32));

const failure = (error: string, status: number, detail?: string) => Response.json(detail ? { error, detail } : { error }, { status });
const stale = () => failure("stale", 409, "The custom endpoint changed. Reload and retry.");

interface Snapshot {
	config: CustomProviderConfig | null;
	corrupt: boolean;
	auth: CustomAuthState;
	etag: string;
}

function snapshot(): Snapshot {
	let config: CustomProviderConfig | null = null;
	let corrupt = false;
	try {
		config = stores.customProviderStore.readConfig();
	} catch (e) {
		if (!(e instanceof CustomProviderCorrupt)) throw e;
		corrupt = true;
	}
	const auth = customAuthState();
	// The revision covers config and binding only, never key material; the
	// key itself is compared privately across the awaited probe.
	const etag = `"${createHmac("sha256", secret).update(JSON.stringify([corrupt ? "corrupt" : config, auth.binding ?? null, auth.readable])).digest("base64url")}"`;
	return { config, corrupt, auth, etag };
}

/** The admin status body. */
function status(s: Snapshot) {
	const { config } = s;
	return {
		configured: Boolean(config),
		...(s.corrupt ? { corrupt: true } : {}),
		usable: customProviderRuntime(config, s.auth) !== null,
		keyPresent: Boolean(s.auth.key),
		keyBound: customKeyAuthorized(config, s.auth),
		config: config
			? { baseUrl: config.baseUrl, mode: config.mode, pricing: config.pricing, snapshot: config.snapshot, manualModels: config.manualModels ?? [], models: config.models ?? {} }
			: null,
	};
}

function statusResponse(): Response {
	const s = snapshot();
	return Response.json(status(s), { headers: { etag: s.etag, "cache-control": "no-store" } });
}

export function customProviderGet(_request: Request): Response {
	if (!currentTenant()?.isAdmin) {
		// Non-admins learn only whether an endpoint exists ("ask your admin" copy).
		const s = snapshot();
		return Response.json({ configured: customProviderRuntime(s.config, s.auth) !== null }, { headers: { "cache-control": "no-store" } });
	}
	return statusResponse();
}

/** Same-origin browser request: Origin's host equals the addressed Host.
 *  The scheme is not compared: TLS ends at Caddy and the inner hop is http.
 *  Forwarded-host headers are never trusted. */
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return false;
	try {
		const host = request.headers.get("host") ?? new URL(request.url).host;
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

class SaveFailed extends Error {}

/** Auth pair FIRST (when it changes), config SECOND (null deletes). On a
 *  failure the whole old pair is restored best-effort; if that fails too,
 *  the nonce mismatch keeps the endpoint closed. */
function commit(next: CustomProviderConfig | null, auth?: { binding: CustomAuthBinding | undefined; key: string | undefined }): void {
	const old = auth ? customAuthState() : undefined;
	let published = false;
	try {
		if (auth) {
			persistCustomAuth(auth.binding, auth.key);
			published = true;
		}
		if (next) stores.customProviderStore.writeConfig(next);
		else stores.customProviderStore.deleteConfig();
	} catch {
		if (published && old?.readable) {
			try {
				persistCustomAuth(old.binding, old.key);
			} catch {
				/* durable nonce mismatch fails closed */
			}
		}
		throw new SaveFailed();
	}
}

export async function customProviderMutation(request: Request): Promise<Response> {
	const denied = requireAdmin();
	if (denied) return denied;
	if (!sameOrigin(request)) return failure("same_origin_required", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure("json_required", 415);
	try {
		// Next can hand an empty DELETE over as a zero-byte stream; only DELETE may be empty.
		const body = await readBoundedJson(request, BODY_LIMIT, request.method === "DELETE");
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("invalid_json", 400);
		const raw = body as Record<string, unknown>;
		const before = snapshot();
		if (before.corrupt) return failure("custom_provider_corrupt", 500, "custom-provider.json is unreadable. Fix or remove it on the server; nothing was saved.");
		if (!before.auth.readable) return failure("auth_unavailable", 500, "The key store is unreadable. Nothing was saved.");
		if (request.headers.get("if-match") !== before.etag) return stale();

		if (request.method === "DELETE") {
			commit(null, { binding: undefined, key: undefined });
			return statusResponse();
		}

		if (request.method === "PATCH") {
			if (raw.models === undefined && raw.pricing === undefined) return failure("invalid_patch", 400, "Send models and/or pricing.");
			if (raw.pricing !== undefined && raw.pricing !== "free" && raw.pricing !== "paid") return failure("invalid_pricing", 400);
			if (!before.config) return failure("not_configured", 409);
			const next: CustomProviderConfig = { ...before.config };
			if (raw.pricing !== undefined) next.pricing = raw.pricing;
			if (raw.models !== undefined) {
				const parsed = parseCustomModelSettings(raw.models, before.config.snapshot.map((m) => m.id));
				if (!parsed.ok) return failure("invalid_models", 400, parsed.error);
				if (Object.keys(parsed.models).length) next.models = parsed.models;
				else delete next.models;
			}
			commit(next);
			return statusResponse();
		}

		// POST: connect or edit.
		const baseUrl = normalizeBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "");
		if (!baseUrl) return failure("invalid_base_url", 400, "Base URL must be http(s), with no credentials, query or fragment.");
		if (raw.mode !== "keyless" && raw.mode !== "key") return failure("invalid_mode", 400, "mode is keyless or key.");
		if (raw.pricing !== "free" && raw.pricing !== "paid") return failure("invalid_pricing", 400, "pricing is free or paid.");
		const { mode, pricing } = raw;
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("invalid_key", 400);
		const supplied = mode === "key" ? (raw.key as string | undefined)?.trim() || undefined : undefined;
		if (supplied && /[\u0000-\u001f\u007f]/.test(supplied)) return failure("invalid_key", 400, "The key contains control characters.");
		const sameTarget = before.config?.baseUrl === baseUrl;
		// A stored key goes only to the URL it was bound to: a new URL needs the key re-entered.
		if (mode === "key" && !supplied && !(sameTarget && customKeyAuthorized(before.config, before.auth))) {
			return failure("key_required", 400, "Enter the API key for this URL.");
		}
		const key = mode === "key" ? (supplied ?? before.auth.key) : undefined;
		const manualModels = parseModelIds(raw.manualModels);
		if (manualModels.length > CUSTOM_MODEL_LIMIT) return failure("invalid_models", 400, `More than ${CUSTOM_MODEL_LIMIT} model ids.`);

		const found = await discoverModels(baseUrl, key);
		if (!found.ok && (found.fatal || found.status === 401 || found.status === 403)) return failure("probe_failed", 502, found.error);
		if (!found.ok && !manualModels.length) return failure("probe_failed", 502, `${found.error}. If this endpoint has no /models list, add model IDs manually.`);

		// The probe yielded: config, binding and key must all be unchanged.
		const now = snapshot();
		if (now.etag !== before.etag || now.auth.key !== before.auth.key) return stale();

		// A failed probe on the same URL keeps the previous snapshot (and so the pins).
		const discovered = found.ok ? found.models : sameTarget ? (before.config?.snapshot ?? []) : [];
		const snapshotList = mergeManualModels(discovered, manualModels);
		if (snapshotList.length > CUSTOM_MODEL_LIMIT) return failure("invalid_models", 400, `More than ${CUSTOM_MODEL_LIMIT} models.`);
		const kept = sameTarget && before.config?.models ? parseCustomModelSettings(before.config.models, snapshotList.map((m) => m.id)) : undefined;
		const models = kept?.ok && Object.keys(kept.models).length ? kept.models : undefined;
		const bindingId = randomBytes(16).toString("hex");
		commit(
			{ version: 1, baseUrl, mode, pricing, bindingId, snapshot: snapshotList, ...(manualModels.length ? { manualModels } : {}), ...(models ? { models } : {}) },
			{ binding: { version: 1, id: bindingId, baseUrl, mode }, key },
		);
		return statusResponse();
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return failure("body_too_large", 413, "The body exceeds 64 KiB.");
		if (error instanceof SyntaxError) return failure("invalid_json", 400);
		return failure("save_failed", 500, "Unable to save the custom endpoint. Reload and retry.");
	}
}
