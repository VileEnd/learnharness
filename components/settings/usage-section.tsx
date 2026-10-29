"use client";
/**
 * Settings → Usage (cost counter, 2026-10-29): read-only. What a month cost,
 * by day and category and session, the 12-month strip, and the month's
 * failed requests. It fetches its own routes (/api/usage, /api/usage/months,
 * /api/usage/failures) and holds no settings field.
 *
 * UsageSection owns the fetching; UsageView is the pure render the tests
 * drive with stubbed data. Unpriced dollars render "—", never $0.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
	monthKey,
	USAGE_TZ,
	type UsageFailuresPage,
	type UsageMonthTotal,
	type UsageMonthView,
} from "@/src/core";
import { costLabel, formatTokens, prettyModel } from "@/components/usage-format";
import {
	CATEGORY_COLORS,
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	DailyBars,
	MonthBars,
	formatMonth,
} from "@/components/usage/charts";
import { SettingsGroup, SettingsRow, ThinSelect } from "./controls.tsx";

/** A block's data: null while loading, "error" when its route failed.
 *  Each block fails alone, so a failed failures page never hides the
 *  month or the charts. */
type Loadable<T> = T | null | "error";

async function getJson<T>(url: string): Promise<T> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`status ${r.status}`);
	return (await r.json()) as T;
}

export function UsageSection({ onNavigate }: { onNavigate?: () => void }) {
	const [month, setMonth] = useState(() => monthKey(new Date()));
	const [months, setMonths] = useState<UsageMonthTotal[] | "error">([]);
	const [view, setView] = useState<Loadable<UsageMonthView>>(null);
	const [page, setPage] = useState(0);
	const [failures, setFailures] = useState<Loadable<UsageFailuresPage>>(null);

	useEffect(() => {
		getJson<UsageMonthTotal[]>("/api/usage/months")
			.then(setMonths)
			.catch(() => setMonths("error"));
	}, []);

	useEffect(() => {
		let live = true;
		setView(null);
		getJson<UsageMonthView>(`/api/usage?month=${month}`)
			.then((v) => live && setView(v))
			.catch(() => live && setView("error"));
		return () => {
			live = false;
		};
	}, [month]);

	useEffect(() => {
		let live = true;
		getJson<UsageFailuresPage>(`/api/usage/failures?month=${month}&page=${page}`)
			.then((f) => live && setFailures(f))
			.catch(() => live && setFailures("error"));
		return () => {
			live = false;
		};
	}, [month, page]);

	return (
		<UsageView
			months={months}
			month={month}
			view={view}
			failures={failures}
			page={page}
			onMonth={(m) => {
				setPage(0);
				setFailures(null);
				setMonth(m);
			}}
			onPage={setPage}
			onNavigate={onNavigate}
		/>
	);
}

const thClass = "py-1.5 font-normal text-muted-foreground";
const numClass = "py-1.5 pl-3 text-right tabular-nums";

export function UsageView({
	months,
	month,
	view,
	failures,
	page,
	onMonth,
	onPage,
	onNavigate,
}: {
	months: UsageMonthTotal[] | "error";
	month: string;
	view: Loadable<UsageMonthView>;
	failures: Loadable<UsageFailuresPage>;
	page: number;
	onMonth: (month: string) => void;
	onPage: (page: number) => void;
	/** A chat link was followed: the dialog closes. */
	onNavigate?: () => void;
}) {
	// The months with data, newest first; the shown month is always pickable.
	const options = (months === "error" ? [] : months).map((m) => m.month).reverse();
	if (!options.includes(month)) options.unshift(month);
	return (
		<div data-testid="usage-section" className="flex flex-col gap-3">
			<SettingsRow label="Month" testid="usage-month-row">
				<ThinSelect value={month} onChange={onMonth} ariaLabel="Month" testid="usage-month">
					{options.map((m) => (
						<option key={m} value={m}>
							{formatMonth(m)}
						</option>
					))}
				</ThinSelect>
			</SettingsRow>

			{view === null ? (
				<p className="text-xs text-muted-foreground/70">Loading usage…</p>
			) : view === "error" ? (
				<p className="text-xs text-muted-foreground/70">This month's usage could not be loaded — reopen Settings to retry.</p>
			) : view.calls === 0 ? (
				<p className="text-xs text-muted-foreground" data-testid="usage-empty">
					No requests logged this month.
				</p>
			) : (
				<>
					<div data-testid="usage-total">
						<p className="font-ui text-2xl tabular-nums text-foreground">{costLabel(view.totalUsd)}</p>
						<p className="font-ui text-xs text-muted-foreground">
							{view.calls} {view.calls === 1 ? "call" : "calls"}
							{view.unpricedCalls > 0 && ` · ${view.unpricedCalls} ${view.unpricedCalls === 1 ? "call" : "calls"} unpriced`}
						</p>
					</div>
					<SettingsGroup label="Daily spend" testid="usage-daily">
						<DailyBars days={view.days} month={view.month} />
					</SettingsGroup>
				</>
			)}

			{months === "error" ? (
				<SettingsGroup label="Last 12 months" testid="usage-months">
					<p className="text-xs text-muted-foreground/70">The monthly totals could not be loaded.</p>
				</SettingsGroup>
			) : (
				months.length > 0 && (
					<SettingsGroup label="Last 12 months" testid="usage-months">
						<MonthBars months={months} selected={month} />
					</SettingsGroup>
				)
			)}

			{view !== null && view !== "error" && view.calls > 0 && (
				<>
					<SettingsGroup label="By category" testid="usage-categories">
						<table className="w-full font-ui text-xs">
							<thead>
								<tr className="border-b border-border/60 text-left">
									<th className={thClass}>Category</th>
									<th className={`${thClass} pl-3 text-right`}>Spend</th>
									<th className={`${thClass} pl-3 text-right`}>Calls</th>
									<th className={`${thClass} pl-3 text-right`}>Tokens</th>
									<th className={`${thClass} pl-3 text-right`}>Unpriced</th>
								</tr>
							</thead>
							<tbody>
								{CATEGORY_ORDER.filter((c) => view.categories[c].calls > 0).map((c) => {
									const t = view.categories[c];
									return (
										<tr key={c} className="border-b border-border/30 last:border-b-0">
											<td className="py-1.5">
												<span className="flex items-center gap-1.5">
													<span className="size-2 shrink-0 rounded-[2px]" style={{ background: CATEGORY_COLORS[c] }} />
													{CATEGORY_LABELS[c]}
												</span>
											</td>
											<td className={numClass}>{costLabel(t.usd)}</td>
											<td className={numClass}>{t.calls}</td>
											<td className={numClass}>{formatTokens(t.tokens)}</td>
											<td className={`${numClass} ${t.unpriced ? "" : "text-muted-foreground/60"}`}>{t.unpriced}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</SettingsGroup>

					{view.sessions.length > 0 && (
						<SettingsGroup label="Sessions" testid="usage-sessions">
							<table className="w-full table-fixed font-ui text-xs">
								<thead>
									<tr className="border-b border-border/60 text-left">
										<th className={thClass}>Session</th>
										<th className={`${thClass} w-18 pl-3`}>Kind</th>
										<th className={`${thClass} w-18 pl-3 text-right`}>Spend</th>
										<th className={`${thClass} w-12 pl-3 text-right`}>Calls</th>
									</tr>
								</thead>
								<tbody>
									{view.sessions.map((s) => (
										<tr key={s.chatId} className="border-b border-border/30 last:border-b-0">
											<td className="truncate py-1.5">
												{s.kind === "deleted" ? (
													<span className="text-muted-foreground">{s.title}</span>
												) : (
													<Link href={`/chat/${s.chatId}`} onNavigate={onNavigate} className="hover:underline">
														{s.title || "Untitled"}
													</Link>
												)}
											</td>
											<td className="py-1.5 pl-3 text-muted-foreground">{KIND_LABEL[s.kind]}</td>
											<td className={numClass}>{costLabel(s.usd)}</td>
											<td className={numClass}>{s.calls}</td>
										</tr>
									))}
								</tbody>
							</table>
						</SettingsGroup>
					)}
				</>
			)}

			{(view === "error" || (view !== null && view.calls > 0)) && (
				<FailedRequests failures={failures} page={page} onPage={onPage} onNavigate={onNavigate} />
			)}
		</div>
	);
}

const KIND_LABEL: Record<UsageMonthView["sessions"][number]["kind"], string> = {
	teach: "Teach",
	practice: "Practice",
	deleted: "Deleted",
};

const timeFmt = new Intl.DateTimeFormat("en-GB", {
	timeZone: USAGE_TZ,
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
});

function FailedRequests({
	failures,
	page,
	onPage,
	onNavigate,
}: {
	failures: Loadable<UsageFailuresPage>;
	page: number;
	onPage: (page: number) => void;
	onNavigate?: () => void;
}) {
	const label = failures && failures !== "error" && failures.total > 0 ? `Failed requests · ${failures.total}` : "Failed requests";
	return (
		<SettingsGroup label={label} testid="usage-failures">
			{failures === null ? (
				<p className="text-xs text-muted-foreground/70">Loading…</p>
			) : failures === "error" ? (
				<p className="text-xs text-muted-foreground/70">Failed requests could not be loaded.</p>
			) : failures.total === 0 ? (
				<p className="text-xs text-muted-foreground">No failed requests this month.</p>
			) : (
				<>
					<ul className="flex flex-col font-ui text-xs">
						{failures.lines.map((l, i) => (
							<li key={`${l.at}-${i}`} className="border-b border-border/30 last:border-b-0" data-testid="usage-failure">
								<details className="group py-1.5">
									<summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-0.5 [&::-webkit-details-marker]:hidden">
										<span className="tabular-nums text-muted-foreground">{timeFmt.format(new Date(l.at))}</span>
										<span>{l.purpose}</span>
										<span className="text-muted-foreground">{prettyModel(`${l.provider}:${l.model}`, true)}</span>
										{l.chatId && (
											<Link href={`/chat/${l.chatId}`} onNavigate={onNavigate} className="ml-auto text-muted-foreground hover:text-foreground hover:underline">
												Open chat
											</Link>
										)}
										<span className="basis-full truncate text-muted-foreground group-open:hidden">{l.error ?? "No error text"}</span>
									</summary>
									<pre className="mt-1 whitespace-pre-wrap break-words font-ui text-xs text-muted-foreground">{l.error ?? "No error text"}</pre>
								</details>
							</li>
						))}
					</ul>
					{failures.total > failures.pageSize && (
						<div className="flex items-center gap-3 pt-1 font-ui text-xs text-muted-foreground">
							<button
								type="button"
								disabled={page === 0}
								onClick={() => onPage(page - 1)}
								className="rounded-sm px-2 py-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
							>
								Newer
							</button>
							<span className="tabular-nums">
								{page * failures.pageSize + 1}–{Math.min((page + 1) * failures.pageSize, failures.total)} of {failures.total}
							</span>
							<button
								type="button"
								disabled={(page + 1) * failures.pageSize >= failures.total}
								onClick={() => onPage(page + 1)}
								className="rounded-sm px-2 py-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
							>
								Older
							</button>
						</div>
					)}
				</>
			)}
		</SettingsGroup>
	);
}
