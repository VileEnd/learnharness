"use client";

/**
 * The monthly cost pill on home (cost counter, 2026-10-29): the bare
 * "This month $x" number, hover-highlighted; a click opens the breakdown
 * (categories, top sessions, failed requests) and a link into Settings →
 * Usage. Replaces the graph-only cost pill on both home variants. Same
 * dismiss pattern as the settings gear: outside click or Escape closes.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "@/components/usage/charts.tsx";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useServerEvent } from "@/components/server-events";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { useSettledBump } from "@/components/use-settled-bump";
import { Hint } from "@/components/ui/hint";
import { costLabel, formatUsd } from "@/components/usage-format";
import type { UsageMonthView } from "@/src/core";

const TOP_SESSIONS = 5;

/** Headline dollars at 2 decimals; sub-cent spend keeps its precision so a
 *  real few tenths of a cent never reads as a flat $0.00. */
const headlineUsd = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : formatUsd(usd));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The current month's usage, fetched on mount and refetched when a turn
 * settles, a background job changes, or the event channel reconnects (the
 * same notify-then-fetch signals as the learner views). Best-effort: a
 * failed fetch keeps the last numbers.
 */
export function useUsageMonth(): UsageMonthView | null {
	const [usage, setUsage] = useState<UsageMonthView | null>(null);
	const [jobsBump, setJobsBump] = useState(0);
	const settled = useSettledBump();
	useServerEvent("jobs-changed", () => setJobsBump((n) => n + 1));
	const refresh = useCallback(() => {
		fetch("/api/usage")
			.then((res) => res.json() as Promise<UsageMonthView>)
			.then(setUsage)
			.catch(() => {});
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh, settled, jobsBump]);
	return usage;
}

export function UsageMonthControl({ usage }: { usage: UsageMonthView | null }) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	const total = usage ? costLabel(usage.totalUsd, headlineUsd) : "—";
	return (
		<div ref={rootRef} className="relative">
			<Hint label="This month's spend — click for details" side="bottom">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
					className={`rounded-lg px-2 py-1 text-xs tabular-nums transition-colors hover:bg-accent ${
						open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
					}`}
				>
					{`This month ${total}`}
				</button>
			</Hint>
			{open && usage && (
				<div className="absolute right-0 top-full mt-2 max-h-[60vh] overflow-y-auto">
					<UsageMonthPanel usage={usage} onNavigate={() => setOpen(false)} />
				</div>
			)}
		</div>
	);
}

/** The breakdown. Pure view of the month; `onNavigate` lets the pill close
 *  itself when a link is followed. */
export function UsageMonthPanel({ usage, onNavigate }: { usage: UsageMonthView; onNavigate?: () => void }) {
	const { open: openSettings } = useSettingsDialog();
	const openUsage = () => {
		onNavigate?.();
		openSettings("usage");
	};
	const rows = CATEGORY_ORDER.filter((c) => usage.categories[c].calls > 0);
	const top = usage.sessions.slice(0, TOP_SESSIONS);
	const linkClass = "underline-offset-2 hover:underline hover:text-foreground";
	return (
		<div className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur">
			<div className="mb-2 flex items-baseline justify-between">
				<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">This month</span>
				<span className="text-foreground tabular-nums">
					{costLabel(usage.totalUsd, headlineUsd)}
					{usage.unpricedCalls > 0 && (
						<span className="text-muted-foreground"> · {plural(usage.unpricedCalls, "call", "calls")} unpriced</span>
					)}
				</span>
			</div>
			<div className="flex flex-col gap-1">
				{rows.map((c) => (
					<div key={c} className="flex items-baseline justify-between gap-2 text-[11px]">
						<span className="shrink-0 text-muted-foreground">{CATEGORY_LABELS[c]}</span>
						<span className="min-w-0 text-right tabular-nums">
							{costLabel(usage.categories[c].usd)}
							<span className="text-muted-foreground"> · {plural(usage.categories[c].calls, "call", "calls")}</span>
						</span>
					</div>
				))}
			</div>
			{top.length > 0 && (
				<div className="mt-2 flex flex-col gap-0.5 border-t pt-2">
					<span className="mb-0.5 text-[10px] text-muted-foreground">
						{plural(usage.sessions.length, "session", "sessions")} with spend
					</span>
					{top.map((s) => (
						<div key={s.chatId} className="flex items-baseline justify-between gap-2 text-[11px]">
							{s.kind === "deleted" ? (
								<span className="min-w-0 flex-1 truncate text-muted-foreground">{s.title}</span>
							) : (
								<Link href={`/chat/${s.chatId}`} onClick={onNavigate} className={`min-w-0 flex-1 truncate text-muted-foreground ${linkClass}`}>
									{s.title}
								</Link>
							)}
							<span className="shrink-0 tabular-nums">{costLabel(s.usd)}</span>
						</div>
					))}
				</div>
			)}
			<div className="mt-2 flex items-baseline justify-between border-t pt-2 text-[11px] text-muted-foreground">
				<button type="button" onClick={openUsage} className={linkClass}>
					{plural(usage.failures, "failed request", "failed requests")}
				</button>
				<button type="button" onClick={openUsage} className={linkClass}>
					Details
				</button>
			</div>
		</div>
	);
}
