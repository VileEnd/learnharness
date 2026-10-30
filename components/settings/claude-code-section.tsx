"use client";
/**
 * Admin-only Claude Code row: the experimental toggle, the runner's CLI status,
 * and a fixed note. Renders nothing for non-admins (the server refuses them too).
 * The view is pure so tests can render every status line.
 */
import { useCallback, useEffect, useState } from "react";
import type { ClaudeCodeStatus } from "@/src/core";
import { Toggle } from "./controls";

/** The status line for a runner status (null while it loads). Pure. */
export function claudeCodeStatusLine(status: ClaudeCodeStatus | null): string {
	switch (status?.state) {
		case "meets-minimum": return `Claude Code ${status.version} ready`;
		case "not-configured": return "Not set up on this server";
		case "not-found": return "The claude container isn't running";
		case "update-required": return `Needs an update (${status.version} < ${status.minimumVersion})`;
		case "version-unchecked": return "Claude Code's version couldn't be checked";
		default: return "Checking…";
	}
}

export function ClaudeCodeSectionView({
	enabled,
	status,
	busy,
	error,
	onToggle,
}: {
	enabled: boolean;
	status: ClaudeCodeStatus | null;
	busy: boolean;
	error: string | null;
	onToggle: (next: boolean) => void;
}) {
	return (
		<div data-testid="claude-code-section" className="flex flex-col gap-1 px-1 py-1.5">
			<div className="flex items-center justify-between gap-3">
				<span className="font-ui text-xs text-foreground">Use Claude Code (experimental)</span>
				<Toggle checked={enabled} disabled={busy} onChange={onToggle} label="Use Claude Code (experimental)" />
			</div>
			<p data-testid="claude-code-status" className="font-mono text-[11px] text-muted-foreground">
				{claudeCodeStatusLine(status)}
			</p>
			{error && (
				<p role="alert" data-testid="claude-code-error" className="text-xs text-red-500">
					{error}
				</p>
			)}
			<p data-testid="claude-code-note" className="text-[11px] text-muted-foreground/70">
				Runs on the account logged into the claude container. Only you can use it; usage isn&apos;t priced.
			</p>
		</div>
	);
}

export function ClaudeCodeSection({ isAdmin }: { isAdmin: boolean }) {
	const [enabled, setEnabled] = useState(false);
	const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const res = await fetch("/api/admin/claude-code", { cache: "no-store" });
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { enabled: boolean; status: ClaudeCodeStatus };
			setEnabled(body.enabled === true);
			setStatus(body.status);
			setError(null);
		} catch {
			setError("Could not load the Claude Code settings.");
		}
	}, []);
	useEffect(() => {
		if (isAdmin) void reload();
	}, [isAdmin, reload]);

	if (!isAdmin) return null;
	const toggle = async (next: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/admin/claude-code", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: next }),
			});
			if (!res.ok) throw new Error(String(res.status));
			setEnabled(((await res.json()) as { enabled: boolean }).enabled === true);
		} catch {
			setError("Could not save the Claude Code setting.");
		} finally {
			setBusy(false);
		}
	};
	return <ClaudeCodeSectionView enabled={enabled} status={status} busy={busy} error={error} onToggle={(n) => void toggle(n)} />;
}
