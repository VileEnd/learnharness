"use client";
/**
 * Settings → Users (admin-only): create users, grant/revoke admin, and
 * manage each user's WireGuard devices. UsersSection owns the fetching
 * against /api/admin/*; UsersSectionView is the pure render the tests
 * drive with stubbed props.
 */

import { useCallback, useEffect, useState } from "react";
import { SettingsGroup } from "./controls.tsx";

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
		/>
	);
}
