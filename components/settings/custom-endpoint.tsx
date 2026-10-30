"use client";
/**
 * The admin-only "Custom endpoint" editor (upstream port 6, task 3; upstream
 * dc4c398 keys-section.tsx, adapted). ONE instance-wide OpenAI-compatible
 * endpoint managed through /api/custom-provider (ETag/If-Match). The fork's
 * differences from upstream: admin-only (the Keys section renders nothing
 * here for anyone else), the key is file-only with no env reuse, pricing
 * (free/paid) is explicit, and paid models carry per-model rates. Every
 * server error lands inline with readable copy; a stale edit offers
 * "Reload and retry".
 */

import { useEffect, useState } from "react";
import { notifySettingsSaved } from "@/components/settings-signal";
import {
	COMPACTION_RESERVE_TOKENS,
	CUSTOM_MODEL_DEFAULT_CONTEXT,
	CUSTOM_MODEL_DEFAULT_MAX_OUTPUT,
	type CustomModel,
	type CustomModelSettings,
	type CustomProviderMode,
	type CustomProviderPricing,
} from "@/src/core";

/** GET /api/custom-provider for an admin (the non-admin shape is only {configured}). */
export interface CustomStatus {
	configured: boolean;
	corrupt?: boolean;
	usable?: boolean;
	keyPresent?: boolean;
	keyBound?: boolean;
	config: null | {
		baseUrl: string;
		mode: CustomProviderMode;
		pricing: CustomProviderPricing;
		snapshot: CustomModel[];
		manualModels?: string[];
		models?: Record<string, CustomModelSettings>;
	};
}

/** A context at or below this compacts the conversation on almost every turn (the teacher prompt alone is ~14k tokens). */
export const LOW_CONTEXT_TOKENS = COMPACTION_RESERVE_TOKENS + 16_384;

const MESSAGES: Record<string, string> = {
	admin_only: "Only an administrator can change the custom endpoint.",
	same_origin_required: "The browser request was refused (it must come from this app's own page). Reload the page and try again.",
	json_required: "The request was not sent as JSON. Reload the page and try again.",
	body_too_large: "That is too much data to send at once. Trim the model list.",
	invalid_json: "The request could not be read. Reload the page and try again.",
	invalid_base_url: "Enter a full http(s) address without a login, query or fragment, e.g. https://llm.example.com/v1.",
	invalid_mode: "Choose keyless or API key.",
	invalid_pricing: "Choose free or paid.",
	invalid_key: "The key may only contain printable ASCII characters.",
	key_required: "Enter the API key for this address. A saved key is only kept for the same address.",
	invalid_models: "A model setting is invalid.",
	invalid_patch: "The model settings could not be saved. Reload and try again.",
	stale: "The endpoint was changed somewhere else since this page loaded. Reloading discards your unsaved edits.",
	not_configured: "No custom endpoint is connected. Connect one first.",
	probe_failed: "Could not reach the endpoint's model list.",
	custom_provider_corrupt: "The custom endpoint file on the server is damaged. Nothing was changed. Check the global custom-provider.json.",
	auth_unavailable: "The server's key store is unavailable, so nothing was changed.",
	save_failed: "The server could not save the change. Nothing was changed.",
	unauthenticated: "You are signed out. Sign in again.",
};

/** Does any provider unlock a model for THIS user? The custom endpoint's row is
 *  keyPresent for every tenant while it is usable, so it counts only when the
 *  catalog also lists a custom model (a restricted user's allow-list can leave
 *  them none). Without `models` the rows are taken at face value. Pure. */
export function hasUsableProvider(
	providers: readonly { id: string; keyPresent: boolean }[],
	models?: readonly { provider: string }[],
): boolean {
	return providers.some((p) => p.keyPresent && (p.id !== "custom" || models === undefined || models.some((m) => m.provider === "custom")));
}

/** Readable copy for an error code (detail is appended when the server gave one). Pure. */
export function customErrorMessage(code: string, detail?: string): string {
	const base = MESSAGES[code] ?? `Something went wrong (${code}).`;
	return detail ? `${base} ${detail}` : base;
}

/** Editable strings for one model's pins and rates. */
export interface PinDraft {
	context: string;
	maxOutput: string;
	/** "" = use the endpoint's report. */
	reasoning: "" | "on" | "off";
	inRate: string;
	outRate: string;
}

/** A draft's context as a number, or undefined when blank or invalid. */
const pinnedContext = (raw: string): number | undefined => (/^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : undefined);

export const pinDraft = (s: CustomModelSettings | undefined): PinDraft => ({
	context: s?.context === undefined ? "" : String(s.context),
	maxOutput: s?.maxOutput === undefined ? "" : String(s.maxOutput),
	reasoning: s?.reasoning === undefined ? "" : s.reasoning ? "on" : "off",
	inRate: s?.inputUsdPerMTok === undefined ? "" : String(s.inputUsdPerMTok),
	outRate: s?.outputUsdPerMTok === undefined ? "" : String(s.outputUsdPerMTok),
});

/** Drafts to the PATCH `models` map; an error string names the first bad field. Rates are both-or-neither. Pure. */
export function pinsPayload(drafts: Record<string, PinDraft>): { ok: true; models: Record<string, CustomModelSettings> } | { ok: false; error: string } {
	const models: Record<string, CustomModelSettings> = {};
	for (const [id, d] of Object.entries(drafts)) {
		const s: CustomModelSettings = {};
		for (const [field, raw, label] of [["context", d.context, "context"], ["maxOutput", d.maxOutput, "max output"]] as const) {
			const t = raw.trim();
			if (t === "") continue;
			if (!/^\d+$/.test(t) || Number(t) <= 0) return { ok: false, error: `${id}: ${label} must be a whole number above 0.` };
			s[field] = Number(t);
		}
		if (d.reasoning) s.reasoning = d.reasoning === "on";
		const i = d.inRate.trim();
		const o = d.outRate.trim();
		if ((i === "") !== (o === "")) return { ok: false, error: `${id}: set both rates (input and output) or neither.` };
		if (i !== "") {
			const ni = Number(i);
			const no = Number(o);
			if (!Number.isFinite(ni) || !Number.isFinite(no) || ni < 0 || no < 0) return { ok: false, error: `${id}: rates must be numbers of 0 or more.` };
			s.inputUsdPerMTok = ni;
			s.outputUsdPerMTok = no;
		}
		if (Object.keys(s).length > 0) models[id] = s;
	}
	return { ok: true, models };
}

const fieldCls =
	"h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const linkBtn =
	"shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

/** The connect form + per-model pins and rates. State starts from `status`; the section remounts it (key=etag) after each change. */
export function CustomEndpointEditor({
	status,
	etag,
	onChanged,
	onReload,
}: {
	status: CustomStatus;
	etag: string;
	onChanged: (status: CustomStatus, etag: string) => void;
	onReload: () => void;
}) {
	const cfg = status.config;
	const [baseUrl, setBaseUrl] = useState(cfg?.baseUrl ?? "");
	const [mode, setMode] = useState<CustomProviderMode>(cfg?.mode ?? "keyless");
	const [pricing, setPricing] = useState<CustomProviderPricing>(cfg?.pricing ?? "free");
	const [key, setKey] = useState("");
	const [manual, setManual] = useState((cfg?.manualModels ?? []).join(", "));
	const [drafts, setDrafts] = useState<Record<string, PinDraft>>(() =>
		Object.fromEntries((cfg?.snapshot ?? []).map((m) => [m.id, pinDraft(cfg?.models?.[m.id])])),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ code: string; message: string } | null>(null);

	async function send(method: "POST" | "PATCH" | "DELETE", body: unknown) {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/custom-provider", {
				method,
				headers: { "content-type": "application/json", "if-match": etag },
				body: JSON.stringify(body),
			});
			const json = (await res.json().catch(() => ({}))) as Partial<CustomStatus> & { error?: string; detail?: string };
			if (!res.ok) {
				const code = json.error ?? `http_${res.status}`;
				setError({ code, message: customErrorMessage(code, json.detail) });
				return;
			}
			notifySettingsSaved("keys");
			notifySettingsSaved("models");
			onChanged(json as CustomStatus, res.headers.get("etag") ?? "");
		} catch {
			setError({ code: "network", message: "Could not reach the server. Check your connection and try again." });
		} finally {
			setBusy(false);
		}
	}

	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	// The saved key only carries over for the same URL and mode.
	const sameTarget = cfg !== null && baseUrl.trim() === cfg.baseUrl && mode === cfg.mode;
	const connect = () =>
		void send("POST", {
			baseUrl: baseUrl.trim(),
			mode,
			pricing,
			...(mode === "key" && key.trim() ? { key: key.trim() } : {}),
			manualModels: manual,
		});
	const savePins = () => {
		const out = pinsPayload(drafts);
		if (!out.ok) return setError({ code: "invalid_models", message: out.error });
		void send("PATCH", { models: out.models, pricing });
	};
	const setDraft = (id: string, patch: Partial<PinDraft>) =>
		setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? pinDraft(undefined)), ...patch } }));

	const models = cfg?.snapshot ?? [];
	const hasRates = (id: string) => {
		const d = drafts[id];
		return d !== undefined && d.inRate.trim() !== "" && d.outRate.trim() !== "";
	};

	return (
		<div data-testid="custom-endpoint-editor" className="flex flex-col gap-2 rounded-sm px-1 py-1.5">
			{status.corrupt && (
				<p role="alert" data-testid="custom-corrupt" className="text-xs text-red-500">
					{customErrorMessage("custom_provider_corrupt")}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="text"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder="https://llm.example.com/v1"
					aria-label="Custom endpoint base URL"
					data-testid="custom-baseurl-input"
					disabled={busy}
					className={`${fieldCls} min-w-48 flex-1`}
				/>
				<select
					value={mode}
					onChange={(e) => setMode(e.target.value as CustomProviderMode)}
					aria-label="Authentication"
					data-testid="custom-auth-mode"
					disabled={busy}
					className={fieldCls}
				>
					<option value="keyless">Keyless</option>
					<option value="key">API key</option>
				</select>
				<select
					value={pricing}
					onChange={(e) => setPricing(e.target.value as CustomProviderPricing)}
					aria-label="Pricing"
					data-testid="custom-pricing"
					disabled={busy}
					className={fieldCls}
				>
					<option value="free">Free (local)</option>
					<option value="paid">Paid (per-model rates)</option>
				</select>
			</div>
			{mode === "key" && (
				<input
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder={status.keyBound && sameTarget ? "Leave blank to keep the saved key" : status.keyBound ? "Enter the key for this endpoint" : "API key"}
					aria-label="Custom endpoint API key"
					data-testid="custom-key-input"
					autoComplete="off"
					disabled={busy}
					className={fieldCls}
				/>
			)}
			<input
				type="text"
				value={manual}
				onChange={(e) => setManual(e.target.value)}
				placeholder="Extra model ids, comma separated (for endpoints without a /models list)"
				aria-label="Manual model ids"
				data-testid="custom-manual-models"
				disabled={busy}
				className={fieldCls}
			/>
			<p data-testid="custom-pricing-help" className="text-[11px] text-muted-foreground/70">
				{pricing === "free"
					? "Free: every call counts as $0, including toward user spending limits."
					: "Paid: calls are priced from the per-model rates below. A model without rates is unpriced, so it cannot be offered to users with a spending limit."}
			</p>
			<div className="flex items-center gap-3">
				<button type="button" onClick={connect} disabled={busy || !baseUrl.trim() || status.corrupt === true} data-testid="custom-save" className={linkBtn}>
					{busy ? "Working…" : cfg ? "Save connection" : "Connect"}
				</button>
				{cfg && !confirmDisconnect && (
					<button
						type="button"
						onClick={() => setConfirmDisconnect(true)}
						disabled={busy}
						data-testid="custom-disconnect"
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
					>
						Disconnect
					</button>
				)}
				{cfg && confirmDisconnect && (
					<span data-testid="custom-disconnect-confirm" className="flex items-center gap-2 text-xs text-red-500">
						Disconnect and delete the key and all model settings?
						<button
							type="button"
							onClick={() => {
								setConfirmDisconnect(false);
								void send("DELETE", {});
							}}
							disabled={busy}
							data-testid="custom-disconnect-yes"
							className="underline underline-offset-2"
						>
							Confirm
						</button>
						<button type="button" onClick={() => setConfirmDisconnect(false)} data-testid="custom-disconnect-no" className="text-muted-foreground underline underline-offset-2">
							Cancel
						</button>
					</span>
				)}
			</div>
			{error && (
				<p role="alert" data-testid="custom-error" className="text-xs text-red-500">
					{error.message}
					{error.code === "stale" && (
						<button type="button" onClick={onReload} data-testid="custom-reload" className="ml-2 underline underline-offset-2">
							Reload and retry
						</button>
					)}
				</p>
			)}
			{models.length > 0 && (
				<div data-testid="custom-pins" className="mt-1 flex flex-col gap-1.5 border-t border-border/60 pt-2">
					<p className="text-[11px] uppercase tracking-widest text-muted-foreground">Models</p>
					{models.map((m) => {
						const d = drafts[m.id] ?? pinDraft(undefined);
						const unpriced = pricing === "paid" && !hasRates(m.id);
						const ctx = pinnedContext(d.context) ?? m.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT;
						return (
							<div key={m.id} data-testid={`custom-model-${m.id}`} className="flex flex-col gap-1">
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="min-w-0 max-w-full truncate font-mono text-xs text-foreground">{m.id}</span>
									<input
										inputMode="numeric"
										value={d.context}
										onChange={(e) => setDraft(m.id, { context: e.target.value })}
										placeholder={`context ${m.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT}`}
										aria-label={`${m.id} context window`}
										data-testid={`custom-pin-context-${m.id}`}
										className={`${fieldCls} w-28`}
									/>
									<input
										inputMode="numeric"
										value={d.maxOutput}
										onChange={(e) => setDraft(m.id, { maxOutput: e.target.value })}
										placeholder={`output ${m.maxOutput ?? CUSTOM_MODEL_DEFAULT_MAX_OUTPUT}`}
										aria-label={`${m.id} max output tokens`}
										data-testid={`custom-pin-maxoutput-${m.id}`}
										className={`${fieldCls} w-28`}
									/>
									<select
										value={d.reasoning}
										onChange={(e) => setDraft(m.id, { reasoning: e.target.value as PinDraft["reasoning"] })}
										aria-label={`${m.id} reasoning effort support`}
										data-testid={`custom-pin-reasoning-${m.id}`}
										className={fieldCls}
									>
										<option value="">Reasoning effort: Use reported</option>
										<option value="on">Reasoning effort: Supported</option>
										<option value="off">Reasoning effort: Not supported</option>
									</select>
									{pricing === "paid" && (
										<>
											<input
												inputMode="decimal"
												value={d.inRate}
												onChange={(e) => setDraft(m.id, { inRate: e.target.value })}
												placeholder="$/M in"
												aria-label={`${m.id} input USD per million tokens`}
												data-testid={`custom-rate-in-${m.id}`}
												className={`${fieldCls} w-20`}
											/>
											<input
												inputMode="decimal"
												value={d.outRate}
												onChange={(e) => setDraft(m.id, { outRate: e.target.value })}
												placeholder="$/M out"
												aria-label={`${m.id} output USD per million tokens`}
												data-testid={`custom-rate-out-${m.id}`}
												className={`${fieldCls} w-20`}
											/>
										</>
									)}
								</div>
								{ctx <= LOW_CONTEXT_TOKENS && (
									<p data-testid={`custom-lowcontext-${m.id}`} className="text-[11px] text-amber-500">
										Context {ctx} is so small that the conversation would be compressed on almost every turn. Raise the context in the backend and pin the same value here.
									</p>
								)}
								{unpriced && (
									<p data-testid={`custom-unpriced-${m.id}`} className="text-[11px] text-amber-500">
										No rates: set rates to offer this to users with a spending limit.
									</p>
								)}
							</div>
						);
					})}
					<button type="button" onClick={savePins} disabled={busy} data-testid="custom-pins-save" className={`${linkBtn} ml-auto`}>
						Save model settings
					</button>
					<div data-testid="custom-help" className="text-[11px] text-muted-foreground/70">
						<p data-testid="custom-budget-help">Context and output pins set the app&apos;s budgets; they do not resize backend context.</p>
						<p data-testid="custom-reasoning-help">Off may not disable reasoning on every backend.</p>
					</div>
				</div>
			)}
		</div>
	);
}

/** The admin's Custom endpoint row + editor. Renders nothing for non-admins (the server refuses them too). */
export function CustomEndpointSection({ isAdmin }: { isAdmin: boolean }) {
	const [state, setState] = useState<{ status: CustomStatus; etag: string } | null>(null);
	const [failed, setFailed] = useState(false);
	const [open, setOpen] = useState(false);

	const reload = async () => {
		try {
			const res = await fetch("/api/custom-provider");
			if (!res.ok) throw new Error(String(res.status));
			const status = (await res.json()) as CustomStatus;
			// A non-admin shape ({configured} only) has no editor to show.
			if (!("config" in status)) throw new Error("not admin");
			setState({ status, etag: res.headers.get("etag") ?? "" });
			setFailed(false);
		} catch {
			setFailed(true);
		}
	};
	useEffect(() => {
		if (isAdmin) void reload();
	}, [isAdmin]);

	if (!isAdmin) return null;
	const cfg = state?.status.config ?? null;
	let summary = "Loading…";
	if (failed) summary = "unavailable";
	else if (state?.status.corrupt) summary = "damaged";
	else if (state) {
		if (!cfg) summary = "not connected";
		else {
			let host = cfg.baseUrl;
			try {
				host = new URL(cfg.baseUrl).host;
			} catch {
				/* keep the raw text */
			}
			summary = `${host} · ${cfg.snapshot.length} models${state.status.usable === false ? " · unavailable" : ""}`;
		}
	}
	return (
		<div data-testid="custom-endpoint-row">
			<button
				type="button"
				aria-expanded={open}
				data-testid="custom-endpoint-row-btn"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
			>
				<span className="font-ui text-xs text-foreground">Custom endpoint</span>
				<span data-testid="custom-endpoint-status" className="max-w-[60%] truncate font-mono text-[11px] text-muted-foreground">
					{summary}
				</span>
			</button>
			{failed && (
				<p role="alert" data-testid="custom-load-error" className="px-1 text-xs text-red-500">
					Could not load the custom endpoint.
					<button type="button" onClick={() => void reload()} className="ml-2 underline underline-offset-2">
						Retry
					</button>
				</p>
			)}
			{open && state && (
				<CustomEndpointEditor
					key={state.etag}
					status={state.status}
					etag={state.etag}
					onChanged={(status, etag) => setState({ status, etag })}
					onReload={() => void reload()}
				/>
			)}
		</div>
	);
}
