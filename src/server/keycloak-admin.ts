/**
 * Keycloak admin client for the Users section: list users, create one with a
 * temporary password, toggle membership of the admin group. Talks to the
 * `learnharness-admin-api` service-account client over the internal network.
 * Secrets (client secret, access token, generated passwords) are never logged.
 */
import { randomInt } from "node:crypto";

const REALM = "learnharness";
const ADMIN_GROUP = "learnharness-admin";
const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface AdminUser {
	id: string;
	username: string;
	email: string | null;
	isAdmin: boolean;
	enabled: boolean;
	createdAt: number | null;
}

export interface KeycloakAdmin {
	listUsers(): Promise<AdminUser[]>;
	createUser(input: { username: string; email?: string; admin: boolean }): Promise<{ user: AdminUser; temporaryPassword: string }>;
	setAdmin(userId: string, admin: boolean): Promise<void>;
}

/** A Keycloak call failed; `status` is Keycloak's HTTP status. */
export class KeycloakError extends Error {
	constructor(readonly status: number, what: string, readonly detail = "") {
		super(`keycloak ${what} failed (${status})`);
		this.name = "KeycloakError";
	}
}

/** The token endpoint rejected the client (400/401: invalid_client / unauthorized_client): the client or its secret is not set up. */
export class KeycloakClientRejected extends KeycloakError {
	constructor(status: number) {
		super(status, "token request");
		this.name = "KeycloakClientRejected";
	}
}

interface KcUser {
	id: string;
	username: string;
	email?: string;
	enabled?: boolean;
	createdTimestamp?: number;
}

export function generatePassword(): string {
	let out = "";
	for (let i = 0; i < 20; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
	return out;
}

export function createKeycloakAdmin(opts: { baseUrl: string; secret: string; fetch?: typeof fetch }): KeycloakAdmin {
	const base = opts.baseUrl.replace(/\/+$/, "");
	const doFetch = (...a: Parameters<typeof fetch>) => (opts.fetch ?? globalThis.fetch)(...a);
	const admin = `${base}/admin/realms/${REALM}`;
	let token: { value: string; expiresAt: number } | null = null;
	let pending: Promise<string> | null = null;
	let adminGroupId: string | null = null;

	function accessToken(): Promise<string> {
		if (token && Date.now() < token.expiresAt) return Promise.resolve(token.value);
		// Concurrent callers share one in-flight token request.
		return (pending ??= fetchToken().finally(() => {
			pending = null;
		}));
	}

	async function fetchToken(): Promise<string> {
		const res = await doFetch(`${base}/realms/${REALM}/protocol/openid-connect/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "client_credentials", client_id: "learnharness-admin-api", client_secret: opts.secret }),
		});
		if (res.status === 400 || res.status === 401) throw new KeycloakClientRejected(res.status);
		if (!res.ok) throw new KeycloakError(res.status, "token request");
		const body = (await res.json()) as { access_token: string; expires_in: number };
		token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 };
		return token.value;
	}

	async function call(path: string, what: string, init: RequestInit = {}): Promise<Response> {
		const res = await doFetch(`${admin}${path}`, {
			...init,
			headers: { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${await accessToken()}` },
		});
		if (!res.ok) {
			const detail = await res.text().then((t) => t.slice(0, 500), () => "");
			throw new KeycloakError(res.status, what, detail);
		}
		return res;
	}

	async function groupId(): Promise<string> {
		if (adminGroupId) return adminGroupId;
		const groups = (await (await call(`/groups?search=${ADMIN_GROUP}&exact=true`, "group lookup")).json()) as { id: string; name: string }[];
		const g = groups.find((x) => x.name === ADMIN_GROUP);
		if (!g) throw new KeycloakError(404, "group lookup");
		return (adminGroupId = g.id);
	}

	async function adminIds(): Promise<Set<string>> {
		const members = (await (await call(`/groups/${await groupId()}/members?briefRepresentation=true&max=500`, "group members")).json()) as KcUser[];
		return new Set(members.map((m) => m.id));
	}

	const toUser = (u: KcUser, admins: Set<string>): AdminUser => ({
		id: u.id,
		username: u.username,
		email: u.email ?? null,
		isAdmin: admins.has(u.id),
		enabled: u.enabled ?? true,
		createdAt: u.createdTimestamp ?? null,
	});

	return {
		async listUsers() {
			const [raw, admins] = await Promise.all([
				call("/users?max=500&briefRepresentation=true", "user list").then((r) => r.json() as Promise<KcUser[]>),
				adminIds(),
			]);
			return raw.map((u) => toUser(u, admins)).sort((a, b) => a.username.localeCompare(b.username));
		},

		async createUser({ username, email, admin: makeAdmin }) {
			const temporaryPassword = generatePassword();
			const res = await call("/users", "user create", {
				method: "POST",
				body: JSON.stringify({
					username,
					...(email ? { email } : {}),
					enabled: true,
					emailVerified: false,
					requiredActions: ["UPDATE_PASSWORD"],
					credentials: [{ type: "password", value: temporaryPassword, temporary: true }],
					groups: ["/learnharness", ...(makeAdmin ? ["/learnharness-admin"] : [])],
				}),
			});
			let id = res.headers.get("location")?.split("/").pop();
			if (!id) {
				// The user exists already (password set); recover the id rather than lose it.
				const found = (await (await call(`/users?username=${encodeURIComponent(username)}&exact=true`, "user lookup")).json()) as KcUser[];
				id = found.find((u) => u.username === username)?.id;
				if (!id) throw new KeycloakError(502, "user create (id not found)");
			}
			return { user: { id, username, email: email ?? null, isAdmin: makeAdmin, enabled: true, createdAt: Date.now() }, temporaryPassword };
		},

		async setAdmin(userId, makeAdmin) {
			await call(`/users/${encodeURIComponent(userId)}/groups/${await groupId()}`, "admin toggle", { method: makeAdmin ? "PUT" : "DELETE" });
		},
	};
}

/** The admin client from env, or null when KC_ADMIN_API_URL / KC_ADMIN_API_SECRET are not both set. */
export function keycloakAdmin(): KeycloakAdmin | null {
	const baseUrl = process.env.KC_ADMIN_API_URL;
	const secret = process.env.KC_ADMIN_API_SECRET;
	if (!baseUrl || !secret) return null;
	// Memoized so the token and admin group id outlive a single request.
	const g = globalThis as { __lhKeycloakAdmin?: { key: string; client: KeycloakAdmin } };
	const key = `${baseUrl}|${secret}`;
	if (g.__lhKeycloakAdmin?.key !== key) g.__lhKeycloakAdmin = { key, client: createKeycloakAdmin({ baseUrl, secret }) };
	return g.__lhKeycloakAdmin.client;
}
