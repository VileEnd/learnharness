"use client";
/**
 * Settings → Users (admin-only): create users, grant/revoke admin, and
 * manage each user's WireGuard devices. UsersSection owns the fetching
 * against /api/admin/*; UsersSectionView is the pure render the tests
 * drive with stubbed props.
 */

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogEntry, PolicyModel, UserPolicy } from "@/src/core";
import { modelKey, recommendedFor } from "@/src/core";
import { costLabel, formatUsd } from "@/components/usage-format";
import { SettingsGroup } from "./controls.tsx";

export interface AdminPolicyData {
	defaults: UserPolicy;
	users: Record<string, UserPolicy>;
}

export interface AdminUsageRow {
	userId: string;
	spentUsd: number | null;
	unpricedCalls: number | null;
	capUsd: number | null;
	restricted: boolean;
	error?: "usage_unreadable";
}

export type PolicySave = UserPolicy | { useDefaults: true };

export interface AdminUser {
	id: string;
	username: string;
	email: string | null;
	isAdmin: boolean;
	enabled: boolean;
	createdAt: number | null;
}

export interface AdminDevice {
	id: string;
	userId: string;
	name: string;
	ip: string;
	createdAt: string;
	revokedAt?: string;
	latestHandshake: number | null;
	stale: boolean;
}

export interface NewDevice {
	username: string;
	name: string;
	config: string;
	qrSvg: string;
}

export interface UsersSectionViewProps {
	users: AdminUser[] | null;
	devices: AdminDevice[];
	/** The signed-in account's name (Keycloak preferred_username). */
	selfName: string | null;
	/** An API error code (or null). */
	error: string | null;
	expandedId: string | null;
	tempPassword: { username: string; password: string } | null;
	newDevice: NewDevice | null;
	loginUrl: string;
	/** Epoch ms, injected so tests are deterministic. */
	now: number;
	busy: boolean;
	onToggle: (userId: string) => void;
	onCreateUser: (input: { username: string; email: string; admin: boolean }) => void;
	onSetAdmin: (userId: string, admin: boolean) => void;
	onAddDevice: (userId: string, name: string) => void;
	onRevoke: (deviceId: string) => void;
	onDismissPassword: () => void;
	onDismissDevice: () => void;
	/** Defaults + per-user policies (null while loading or unavailable). */
	policy: AdminPolicyData | null;
	usage: AdminUsageRow[] | null;
	/** The model catalog the pickers draw from. */
	catalog: ModelCatalogEntry[] | undefined;
	/** Detail of the last rejected policy save (or null). */
	saveError: string | null;
	/** Which editor the error belongs to: "defaults" or a user id. */
	saveErrorFor?: string | null;
	onSaveDefaults: (policy: UserPolicy) => void;
	onSaveUserPolicy: (userId: string, policy: PolicySave) => void;
}

const MESSAGES: Record<string, string> = {
	user_admin_not_configured: "User management isn't set up on this server yet.",
	wireguard_not_ready: "WireGuard isn't set up on this server yet.",
	wireguard_peers_corrupt:
		"The WireGuard device list on the server is damaged — nothing was changed. Check data/global/wireguard/peers.json.",
	wireguard_full: "No free WireGuard addresses left.",
	username_taken: "That username is already taken.",
	email_taken: "That email is already used by another account.",
	invalid_username:
		"Use 2–32 lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.",
	invalid_email: "That email address isn't valid.",
	invalid_name: "Device names use letters, digits, spaces, dot, dash or underscore (up to 40).",
	self_demotion: "You can't remove your own admin rights.",
	keycloak_unavailable: "The login server (Keycloak) can't be reached right now.",
};

export function errorMessage(code: string): string {
	return MESSAGES[code] ?? `Something went wrong (${code})`;
}

/** "never" for no handshake, else a coarse relative time. */
function lastSeen(handshakeSec: number | null, now: number): string {
	if (handshakeSec === null) return "never";
	const s = Math.max(0, Math.floor(now / 1000 - handshakeSec));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const inputCls =
	"min-w-0 rounded-sm border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-foreground/50";
const btnCls =
	"shrink-0 rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

function Panel({ children, testid }: { children: React.ReactNode; testid: string }) {
	return (
		<div data-testid={testid} className="flex flex-col gap-2 rounded-sm border border-border p-3 text-sm">
			{children}
		</div>
	);
}

function CopyButton({ text }: { text: string }) {
	return (
		<button
			type="button"
			className={btnCls}
			onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}
		>
			Copy
		</button>
	);
}

function DownloadConf({ device }: { device: NewDevice }) {
	const [href, setHref] = useState<string | null>(null);
	useEffect(() => {
		const url = URL.createObjectURL(new Blob([device.config], { type: "text/plain" }));
		setHref(url);
		return () => URL.revokeObjectURL(url);
	}, [device.config]);
	return (
		<a
			data-testid="device-download"
			className={btnCls}
			href={href ?? undefined}
			download={`${safe(device.username)}-${safe(device.name)}.conf`}
		>
			Download .conf
		</a>
	);
}

const SLOTS = ["strong", "cheap", "vision"] as const;

/** "provider:id" → coordinates (provider never contains a colon). */
function parseKey(key: string): PolicyModel {
	const i = key.indexOf(":");
	return { provider: key.slice(0, i), id: key.slice(i + 1) };
}

/** Build a policy from editor state; null when the cap text is invalid. */
export function toPolicy(slots: UserPolicy["slots"], allowed: Iterable<string>, capText: string): UserPolicy | null {
	const t = capText.trim();
	const cap = t === "" ? null : Number(t);
	if (cap !== null && !(Number.isFinite(cap) && cap >= 0)) return null;
	const out: UserPolicy["slots"] = {};
	for (const slot of SLOTS) if (slots[slot]) out[slot] = slots[slot];
	return { slots: out, allowedModels: [...new Set(allowed)], monthlyCapUsd: cap };
}

/** The shared editor: three slot pickers, "Also allowed", monthly limit. */
function PolicyFields({
	value,
	catalog,
	busy,
	idPrefix,
	onSave,
	saveLabel,
	error,
}: {
	error?: string | null;
	value: UserPolicy;
	catalog: ModelCatalogEntry[] | undefined;
	busy: boolean;
	idPrefix: string;
	onSave: (policy: UserPolicy) => void;
	saveLabel: string;
}) {
	const [slots, setSlots] = useState(value.slots);
	const [allowed, setAllowed] = useState(new Set(value.allowedModels));
	const [cap, setCap] = useState(value.monthlyCapUsd === null ? "" : String(value.monthlyCapUsd));
	const [search, setSearch] = useState("");
	const models = catalog ?? [];
	const cheapest = new Set(
		recommendedFor(models)
			.filter((r) => r.entry.badge === "Cheapest")
			.map((r) => modelKey(r.model)),
	);
	const draft = toPolicy(slots, allowed, cap);
	const q = search.trim().toLowerCase();
	const shown = models.filter((m) => q === "" || `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q));
	const optionLabel = (m: ModelCatalogEntry) => `${m.name} (${m.provider})${cheapest.has(modelKey(m)) ? " — Recommended" : ""}`;
	return (
		<div className="flex flex-col gap-2 text-xs">
			{SLOTS.map((slot) => {
				const cur = slots[slot];
				const curKey = cur ? modelKey(cur) : "";
				const known = models.some((m) => modelKey(m) === curKey);
				return (
					<label key={slot} className="flex items-center gap-2">
						<span className="w-14 text-muted-foreground">{slot}</span>
						<select
							data-testid={`${idPrefix}-slot-${slot}`}
							className={`${inputCls} flex-1`}
							value={curKey}
							onChange={(e) => {
								const next = { ...slots };
								if (e.target.value === "") delete next[slot];
								else next[slot] = parseKey(e.target.value);
								setSlots(next);
							}}
						>
							<option value="">— none —</option>
							{cur && !known && <option value={curKey}>{curKey}</option>}
							{models.map((m) => (
								<option key={modelKey(m)} value={modelKey(m)}>
									{optionLabel(m)}
								</option>
							))}
						</select>
					</label>
				);
			})}
			<div className="flex flex-col gap-1">
				<span className="text-muted-foreground">Also allowed</span>
				<input className={inputCls} placeholder="search models" aria-label="search models" value={search} onChange={(e) => setSearch(e.target.value)} />
				<div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-sm border border-border/60 p-1">
					{shown.map((m) => (
						<label key={modelKey(m)} className="flex items-center gap-1">
							<input
								type="checkbox"
								checked={allowed.has(modelKey(m))}
								onChange={(e) => {
									const next = new Set(allowed);
									if (e.target.checked) next.add(modelKey(m));
									else next.delete(modelKey(m));
									setAllowed(next);
								}}
							/>
							{optionLabel(m)}
						</label>
					))}
				</div>
			</div>
			<label className="flex items-center gap-2">
				<span className="text-muted-foreground">Monthly limit ($)</span>
				<input
					className={`${inputCls} w-24`}
					inputMode="decimal"
					placeholder="no limit"
					aria-label="Monthly limit"
					value={cap}
					onChange={(e) => setCap(e.target.value)}
				/>
			</label>
			<div>
				<button
					type="button"
					className={btnCls}
					disabled={busy || draft === null}
					onClick={() => draft && onSave(draft)}
				>
					{saveLabel}
				</button>
			</div>
			{error && (
				<p role="alert" data-testid={`${idPrefix}-save-error`} className="text-red-500">
					Couldn&apos;t save: {error}
				</p>
			)}
		</div>
	);
}

function UserPolicyEditor({
	userId,
	policy,
	catalog,
	busy,
	onSave,
	error,
}: {
	error?: string | null;
	userId: string;
	policy: AdminPolicyData;
	catalog: ModelCatalogEntry[] | undefined;
	busy: boolean;
	onSave: (policy: PolicySave) => void;
}) {
	const own = policy.users[userId];
	const [useDefaults, setUseDefaults] = useState(own === undefined);
	return (
		<div data-testid={`policy-editor-${userId}`} className="flex flex-col gap-2">
			<span className="text-sm">Models &amp; limit</span>
			<label className="flex items-center gap-1 text-xs">
				<input type="checkbox" checked={useDefaults} onChange={(e) => setUseDefaults(e.target.checked)} />
				Use defaults
			</label>
			{useDefaults ? (
				<div>
					<button type="button" className={btnCls} disabled={busy} onClick={() => onSave({ useDefaults: true })}>
						Save
					</button>
					{error && <p role="alert" data-testid={`user-${userId}-save-error`} className="mt-1 text-xs text-red-500">Couldn&apos;t save: {error}</p>}
				</div>
			) : (
				<PolicyFields value={own ?? policy.defaults} catalog={catalog} busy={busy} idPrefix={`user-${userId}`} onSave={onSave} saveLabel="Save" error={error} />
			)}
		</div>
	);
}

function spendLine(row: AdminUsageRow): string {
	const cap = row.capUsd === null ? "no limit" : `of ${formatUsd(row.capUsd)}`;
	return `${costLabel(row.spentUsd)} this month ${cap}`;
}

function AddUserForm({ busy, onCreate }: { busy: boolean; onCreate: UsersSectionViewProps["onCreateUser"] }) {
	const [username, setUsername] = useState("");
	const [email, setEmail] = useState("");
	const [admin, setAdmin] = useState(false);
	return (
		<form
			data-testid="add-user-form"
			className="flex flex-wrap items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				onCreate({ username: username.trim(), email: email.trim(), admin });
				setUsername("");
				setEmail("");
				setAdmin(false);
			}}
		>
			<input className={inputCls} placeholder="username" aria-label="username" value={username} onChange={(e) => setUsername(e.target.value)} />
			<input className={inputCls} placeholder="email (optional)" aria-label="email" value={email} onChange={(e) => setEmail(e.target.value)} />
			<label className="flex items-center gap-1 text-xs text-muted-foreground">
				<input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> admin
			</label>
			<button type="submit" className={btnCls} disabled={busy || username.trim() === ""}>
				Add user
			</button>
		</form>
	);
}

function AddDeviceForm({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => void }) {
	const [name, setName] = useState("");
	return (
		<form
			className="flex items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				onAdd(name.trim());
				setName("");
			}}
		>
			<input className={inputCls} placeholder="device name" aria-label="device name" value={name} onChange={(e) => setName(e.target.value)} />
			<button type="submit" className={btnCls} disabled={busy || name.trim() === ""}>
				Add device
			</button>
		</form>
	);
}

export function UsersSectionView(p: UsersSectionViewProps) {
	const live = p.devices.filter((d) => d.revokedAt === undefined);
	return (
		<div data-testid="section-users" className="flex flex-col gap-4">
			{p.error && (
				<p role="alert" data-testid="users-error" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
					{errorMessage(p.error)}
				</p>
			)}
			{p.tempPassword && (
				<Panel testid="temp-password-panel">
					<p>
						Temporary password for {p.tempPassword.username}:{" "}
						<code data-testid="temp-password">{p.tempPassword.password}</code>
					</p>
					<p className="text-xs text-muted-foreground">
						They&apos;ll set their own password (and name/email, if missing) at first login. This password is not shown again.
					</p>
					<p className="text-xs text-muted-foreground">
						Share the login URL: <code>{p.loginUrl}</code>
					</p>
					<div className="flex gap-2">
						<CopyButton text={p.tempPassword.password} />
						<button type="button" className={btnCls} onClick={p.onDismissPassword}>
							Done
						</button>
					</div>
				</Panel>
			)}
			{p.newDevice && (
				<Panel testid="new-device-panel">
					{/* qrSvg is the server's own `qrcode` output for the device config, not user HTML. */}
					<div className="size-48 bg-white p-2" data-testid="device-qr" dangerouslySetInnerHTML={{ __html: p.newDevice.qrSvg }} />
					<p className="text-xs text-muted-foreground">
						Scan with the WireGuard app. The private key is not stored — if lost, revoke and create a new device.
					</p>
					<div className="flex gap-2">
						<DownloadConf device={p.newDevice} />
						<button type="button" className={btnCls} onClick={p.onDismissDevice}>
							Done
						</button>
					</div>
				</Panel>
			)}
			{p.saveError && (
				<p role="alert" data-testid="policy-error" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
					Couldn&apos;t save: {p.saveError}
				</p>
			)}
			{p.policy && (
				<SettingsGroup label="New user defaults">
					<PolicyFields value={p.policy.defaults} catalog={p.catalog} busy={p.busy} idPrefix="defaults" onSave={p.onSaveDefaults} saveLabel="Save defaults" error={p.saveErrorFor === "defaults" ? p.saveError : null} />
				</SettingsGroup>
			)}
			<SettingsGroup label="Add user">
				<AddUserForm busy={p.busy} onCreate={p.onCreateUser} />
			</SettingsGroup>
			<SettingsGroup label="Users">
				{p.users === null ? (
					<p className="text-xs text-muted-foreground/70">Loading users…</p>
				) : (
					p.users.map((u) => {
						const mine = live.filter((d) => d.userId === u.id);
						const open = p.expandedId === u.id;
						const self = u.username === p.selfName;
						const row = p.usage?.find((r) => r.userId === u.id);
						const reached = row !== undefined && row.spentUsd !== null && row.capUsd !== null && row.spentUsd >= row.capUsd;
						return (
							<div key={u.id} data-testid={`user-${u.id}`} className="flex flex-col gap-2 rounded-sm border border-border/60 px-3 py-2">
								<button type="button" className="flex flex-wrap items-center gap-2 text-left text-sm" aria-expanded={open} onClick={() => p.onToggle(u.id)}>
									<span>{u.username}</span>
									{u.email && <span className="text-xs text-muted-foreground">{u.email}</span>}
									{u.isAdmin && (
										<span data-testid={`user-admin-badge-${u.id}`} className="rounded-sm border border-border px-1.5 text-xs">
											admin
										</span>
									)}
									{!row && !u.isAdmin && (
										<span data-testid={`user-spend-${u.id}`} className="text-xs text-muted-foreground">
											no usage yet
										</span>
									)}
									{!row && u.isAdmin && (
										<span data-testid={`user-spend-${u.id}`} className="text-xs text-muted-foreground">
											admin — unrestricted
										</span>
									)}
									{row && (
										<span data-testid={`user-spend-${u.id}`} className="text-xs text-muted-foreground">
											{row.restricted ? spendLine(row) : "admin — unrestricted"}
											{row.restricted && row.unpricedCalls !== null && row.unpricedCalls > 0 && ` (+${row.unpricedCalls} unpriced calls)`}
											{row.error === "usage_unreadable" && " · Usage unavailable"}
										</span>
									)}
									{reached && (
										<span data-testid={`user-limit-${u.id}`} className="rounded-sm border border-red-500/50 px-1.5 text-xs text-red-500">
											limit reached
										</span>
									)}
									<span className="ml-auto text-xs text-muted-foreground">
										{mine.length} {mine.length === 1 ? "device" : "devices"}
									</span>
								</button>
								{open && (
									<div className="flex flex-col gap-2 border-t border-border/60 pt-2">
										{mine.map((d) => (
											<div key={d.id} data-testid={`device-${d.id}`} className="flex flex-wrap items-center gap-2 text-xs">
												<span className="text-sm">{d.name}</span>
												<span className="text-muted-foreground">{d.ip}</span>
												<span className="text-muted-foreground">last seen {lastSeen(d.latestHandshake, p.now)}</span>
												{d.stale && <span className="rounded-sm border border-amber-500/50 px-1.5 text-amber-500">outdated — re-create</span>}
												<button type="button" className={`${btnCls} ml-auto`} disabled={p.busy} onClick={() => p.onRevoke(d.id)}>
													Revoke
												</button>
											</div>
										))}
										<AddDeviceForm busy={p.busy} onAdd={(name) => p.onAddDevice(u.id, name)} />
										{p.policy && (row ? row.restricted : !u.isAdmin) && (
											<UserPolicyEditor
												userId={u.id}
												policy={p.policy}
												catalog={p.catalog}
												busy={p.busy}
												error={p.saveErrorFor === u.id ? p.saveError : null}
												onSave={(pol) => p.onSaveUserPolicy(u.id, pol)}
											/>
										)}
										<div>
											<button
												type="button"
												data-testid={`user-admin-toggle-${u.id}`}
												className={btnCls}
												disabled={p.busy || self}
												onClick={() => p.onSetAdmin(u.id, !u.isAdmin)}
											>
												{u.isAdmin ? "Remove admin" : "Make admin"}
											</button>
											<p className="mt-1 text-xs text-muted-foreground">Admin changes take effect at the person&apos;s next login (or within an hour).</p>
										</div>
									</div>
								)}
							</div>
						);
					})
				)}
			</SettingsGroup>
		</div>
	);
}

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
	const r = await fetch(url, init);
	const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
	return { ok: r.ok, status: r.status, body };
}
const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

export function UsersSection({ selfName }: { selfName: string | null }) {
	const [users, setUsers] = useState<AdminUser[] | null>(null);
	const [devices, setDevices] = useState<AdminDevice[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);
	const [newDevice, setNewDevice] = useState<NewDevice | null>(null);
	const [busy, setBusy] = useState(false);
	const [policy, setPolicy] = useState<AdminPolicyData | null>(null);
	const [usage, setUsage] = useState<AdminUsageRow[] | null>(null);
	const [catalog, setCatalog] = useState<ModelCatalogEntry[] | undefined>(undefined);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveErrorFor, setSaveErrorFor] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const u = await call("/api/admin/users");
		if (!u.ok) {
			setError((cur) => cur ?? String(u.body.error ?? u.status));
			setUsers([]);
			return;
		}
		setUsers((u.body.users as AdminUser[]) ?? []);
		const d = await call("/api/admin/devices");
		if (d.ok) setDevices((d.body.devices as AdminDevice[]) ?? []);
		else setError((cur) => cur ?? String(d.body.error ?? d.status));
		const pol = await call("/api/admin/policy");
		if (pol.ok) setPolicy({ defaults: pol.body.defaults as UserPolicy, users: (pol.body.users as Record<string, UserPolicy>) ?? {} });
		else setError((cur) => cur ?? String(pol.body.error ?? pol.status));
		const us = await call("/api/admin/usage");
		if (us.ok) setUsage((us.body.users as AdminUsageRow[]) ?? []);
		const cat = await call("/api/models");
		if (cat.ok) setCatalog((cat.body.models as ModelCatalogEntry[]) ?? []);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** Run one mutation: surface its error code, then reload. */
	const run = async (fn: () => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>, onOk?: (b: Record<string, unknown>) => void) => {
		setBusy(true);
		setError(null);
		try {
			const r = await fn();
			if (!r.ok) setError(String(r.body.error ?? r.status));
			else onOk?.(r.body);
		} catch {
			setError("network");
		}
		try {
			await refresh();
		} catch {
			setError((cur) => cur ?? "network"); // keep the mutation's own error
		} finally {
			setBusy(false);
		}
	};

	/** A policy save: a 400 invalid_policy shows its detail, anything else the generic code. */
	const savePolicy = async (target: string, url: string, body: unknown) => {
		setBusy(true);
		setSaveError(null);
		setSaveErrorFor(target);
		try {
			const r = await call(url, json("PUT", body));
			if (!r.ok) {
				if (r.body.error === "invalid_policy") setSaveError(String(r.body.detail ?? "invalid policy"));
				else setError(String(r.body.error ?? r.status));
			}
		} catch {
			setError("network");
		}
		try {
			await refresh();
		} catch {
			setError((cur) => cur ?? "network");
		} finally {
			setBusy(false);
		}
	};

	const username = (id: string) => users?.find((u) => u.id === id)?.username ?? id;

	return (
		<UsersSectionView
			users={users}
			devices={devices}
			selfName={selfName}
			error={error}
			expandedId={expandedId}
			tempPassword={tempPassword}
			newDevice={newDevice}
			loginUrl={`https://${typeof window === "undefined" ? "" : window.location.host}/`}
			now={Date.now()}
			busy={busy}
			onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
			onCreateUser={(input) =>
				void run(
					() => call("/api/admin/users", json("POST", { username: input.username, ...(input.email ? { email: input.email } : {}), admin: input.admin })),
					(b) => setTempPassword({ username: (b.user as AdminUser).username, password: String(b.temporaryPassword) }),
				)
			}
			onSetAdmin={(id, admin) => void run(() => call(`/api/admin/users/${id}/admin`, json("PUT", { admin })))}
			onAddDevice={(userId, name) =>
				void run(
					() => call("/api/admin/devices", json("POST", { userId, name })),
					(b) => setNewDevice({ username: username(userId), name, config: String(b.config), qrSvg: String(b.qrSvg) }),
				)
			}
			onRevoke={(id) => void run(() => call(`/api/admin/devices/${id}`, { method: "DELETE" }))}
			onDismissPassword={() => setTempPassword(null)}
			onDismissDevice={() => setNewDevice(null)}
			policy={policy}
			usage={usage}
			catalog={catalog}
			saveError={saveError}
			saveErrorFor={saveErrorFor}
			onSaveDefaults={(pol) => void savePolicy("defaults", "/api/admin/policy/defaults", pol)}
			onSaveUserPolicy={(id, pol) => void savePolicy(id, `/api/admin/users/${id}/policy`, pol)}
		/>
	);
}
