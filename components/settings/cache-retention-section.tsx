"use client";
/**
 * Admin-only prompt-cache retention row (next to the Claude Code row): how long
 * the provider keeps a conversation's prompt prefix cached. Applies to chat
 * turns only (teacher, prober, practice), for every user. Renders nothing for
 * non-admins (the server refuses them too). The view is pure so tests can
 * render it.
 */
import { useCallback, useEffect, useState } from "react";
import type { CacheRetentionPref } from "@/src/core";
import { ThinSelect } from "./controls";

export function CacheRetentionSectionView({
	value,
	loaded,
	busy,
	error,
	onChange,
}: {
	value: CacheRetentionPref;
	/** The first GET has finished (either way); until then the control is disabled. */
	loaded: boolean;
	busy: boolean;
	error: string | null;
	onChange: (next: CacheRetentionPref) => void;
}) {
	return (
		<div data-testid="cache-retention-section" className="flex flex-col gap-1 px-1 py-1.5">
			<div className="flex items-center justify-between gap-3">
				<span className="font-ui text-xs text-foreground">Prompt cache for chat turns</span>
				<ThinSelect
					value={value}
					onChange={(v) => onChange(v === "long" ? "long" : "short")}
					ariaLabel="Prompt cache retention for chat turns"
					testid="cache-retention-select"
					disabled={busy || !loaded}
				>
					<option value="short">Short, about 5 min (default)</option>
					<option value="long">Long, 1 hour</option>
				</ThinSelect>
			</div>
			{error && (
				<p role="alert" data-testid="cache-retention-error" className="text-xs text-error">
					{error}
				</p>
			)}
			<p data-testid="cache-retention-note" className="text-[11px] text-muted-foreground/70">
				Writing a 1-hour cache costs 2× the input price instead of 1.25× for the short one. It pays off only when learners
				often pause 5 to 60 minutes between turns; otherwise it costs more. Compare the cache hit rate under Usage before
				and after switching. Applies to all users&apos; chat turns on Anthropic, OpenRouter Anthropic, Bedrock and OpenAI
				models; background jobs, extraction and the custom endpoint always use the default.
			</p>
		</div>
	);
}

export function CacheRetentionSection({ isAdmin }: { isAdmin: boolean }) {
	const [value, setValue] = useState<CacheRetentionPref>("short");
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const res = await fetch("/api/admin/cache-retention", { cache: "no-store" });
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { conversation: CacheRetentionPref };
			setValue(body.conversation === "long" ? "long" : "short");
			setError(null);
		} catch {
			setError("Could not load the cache setting.");
		} finally {
			setLoaded(true);
		}
	}, []);
	useEffect(() => {
		if (isAdmin) void reload();
	}, [isAdmin, reload]);

	if (!isAdmin) return null;
	const change = async (next: CacheRetentionPref) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/admin/cache-retention", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversation: next }),
			});
			if (!res.ok) throw new Error(String(res.status));
			setValue(((await res.json()) as { conversation: CacheRetentionPref }).conversation === "long" ? "long" : "short");
		} catch {
			setError("Could not save the cache setting.");
		} finally {
			setBusy(false);
		}
	};
	return <CacheRetentionSectionView value={value} loaded={loaded} busy={busy} error={error} onChange={(n) => void change(n)} />;
}
