"use client";
/**
 * Admin-only model-catalog rows in Settings → Agent → Models: "Refresh models"
 * asks pi.dev for new model ids now (POST /api/models), and the switch turns
 * the daily automatic refresh on or off (GET/PUT /api/admin/model-catalog).
 * Renders nothing for non-admins (the server refuses them too). The view is
 * pure so tests can render it.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ModelCatalogAdminView, ModelCatalogRefreshOutcome } from "@/src/core";
import { Button } from "@/components/ui/button";
import { SettingsRow, Toggle } from "./controls.tsx";

export type RefreshState = ModelCatalogRefreshOutcome | "pending" | "failed";

const REFRESH_MESSAGES: Record<RefreshState, string> = {
	pending: "Refreshing…",
	updated: "New models added.",
	unchanged: "No new models.",
	"no-providers": "No keyed provider has a catalog to refresh.",
	failed: "Could not refresh. The current catalog is still in use.",
};

export function ModelCatalogSectionView({
	refresh,
	autoRefresh,
	loaded,
	busy,
	error,
	onRefresh,
	onAutoRefresh,
}: {
	refresh: RefreshState | null;
	autoRefresh: boolean;
	/** The first GET has finished (either way); until then the switch is disabled. */
	loaded: boolean;
	busy: boolean;
	error: string | null;
	onRefresh: () => void;
	onAutoRefresh: (on: boolean) => void;
}) {
	const pending = refresh === "pending";
	return (
		<div data-testid="model-catalog-section" className="flex flex-col gap-1">
			<SettingsRow
				label="Refresh models"
				hint={refresh ? REFRESH_MESSAGES[refresh] : "Ask pi.dev for new models of the providers with a key"}
				testid="model-catalog-refresh-row"
			>
				<Button
					type="button"
					variant="outline"
					size="icon-sm"
					aria-label="Refresh models"
					title="Refresh models"
					aria-busy={pending}
					disabled={pending}
					onClick={onRefresh}
				>
					<RefreshCw aria-hidden="true" className={pending ? "animate-spin" : undefined} />
				</Button>
			</SettingsRow>
			<SettingsRow label="Refresh models daily" hint="Once a day, for every user" testid="model-catalog-auto-row">
				<Toggle checked={autoRefresh} disabled={busy || !loaded} label="daily model refresh" onChange={onAutoRefresh} />
			</SettingsRow>
			{error && (
				<p role="alert" data-testid="model-catalog-error" className="text-xs text-error">
					{error}
				</p>
			)}
		</div>
	);
}

export function ModelCatalogSection({ isAdmin, onRefreshed }: { isAdmin: boolean; onRefreshed: () => void }) {
	const [refresh, setRefresh] = useState<RefreshState | null>(null);
	const [autoRefresh, setAutoRefresh] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const res = await fetch("/api/admin/model-catalog", { cache: "no-store" });
			if (!res.ok) throw new Error(String(res.status));
			setAutoRefresh(((await res.json()) as ModelCatalogAdminView).autoRefresh !== false);
			setError(null);
		} catch {
			setError("Could not load the refresh setting.");
		} finally {
			setLoaded(true);
		}
	}, []);
	useEffect(() => {
		if (isAdmin) void reload();
	}, [isAdmin, reload]);

	if (!isAdmin) return null;
	const runRefresh = async () => {
		setRefresh("pending");
		try {
			const res = await fetch("/api/models", { method: "POST" });
			if (!res.ok) throw new Error(String(res.status));
			setRefresh(((await res.json()) as { outcome: ModelCatalogRefreshOutcome }).outcome);
			onRefreshed();
		} catch {
			setRefresh("failed");
		}
	};
	const changeAuto = async (on: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/admin/model-catalog", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ autoRefresh: on }),
			});
			if (!res.ok) throw new Error(String(res.status));
			setAutoRefresh(((await res.json()) as ModelCatalogAdminView).autoRefresh !== false);
		} catch {
			setError("Could not save the refresh setting.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<ModelCatalogSectionView
			refresh={refresh}
			autoRefresh={autoRefresh}
			loaded={loaded}
			busy={busy}
			error={error}
			onRefresh={() => void runRefresh()}
			onAutoRefresh={(on) => void changeAuto(on)}
		/>
	);
}
