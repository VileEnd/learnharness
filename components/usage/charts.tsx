/**
 * The usage charts (cost counter, 2026-10-29): hand-made SVG bars, no chart
 * library. Marks only live in the SVG; every piece of text (axis values, day
 * and month ticks, the legend) is HTML beside it, so the plot can stretch to
 * the dialog's width without squashing type on a phone.
 *
 * The SVG's viewBox height equals its CSS height and only the x axis
 * stretches (preserveAspectRatio="none"): vertical gaps stay exact pixels,
 * strokes stay hairlines (non-scaling-stroke). Each bar is one <g> with a
 * native <title> tooltip and a transparent hit path the full column high, so
 * a thin or empty bar is still easy to hover.
 */

import type { UsageCategory, UsageMonth, UsageMonthTotal } from "@/src/core";
import { costLabel } from "@/components/usage-format";

/** Display order: bottom of the stack first, and the order of every table. */
export const CATEGORY_ORDER: readonly UsageCategory[] = [
	"teaching",
	"practice",
	"canvas-reader",
	"graph",
	"jobs",
	"library",
	"learner",
	"search",
];

export const CATEGORY_LABELS: Record<UsageCategory, string> = {
	teaching: "Teaching",
	practice: "Practice",
	"canvas-reader": "Canvas reader",
	graph: "Graph",
	jobs: "Background jobs",
	library: "Library",
	learner: "Learner model",
	search: "Search",
};

/**
 * The app palette's hue families (components/canvas/geometry.ts: blue,
 * orange, green, yellow, purple, red, plus aqua and magenta for eight),
 * stepped for the dark chart surface. geometry.ts's own dark steps are
 * pen colours: too light for fills, and its red and orange are too close
 * to sit side by side in a stack. These steps pass the dataviz palette
 * validator on #1c1c1c (lightness band, chroma, adjacent CVD ΔE ≥ 8,
 * normal-vision ΔE ≥ 15, contrast ≥ 3:1) in this order, which is also the
 * stacking order, so neighbours in a bar stay distinguishable.
 */
export const CATEGORY_COLORS: Record<UsageCategory, string> = {
	teaching: "#3987e5",
	practice: "#d95926",
	"canvas-reader": "#199e70",
	graph: "#c98500",
	jobs: "#d55181",
	library: "#008300",
	learner: "#9085e9",
	search: "#e66767",
};

const PLOT_H = 120;
/** Headroom above the top gridline, px. */
const TOP = 6;
/** Surface gap between stacked segments, px. */
const GAP = 1.5;
/** Width of one slot in viewBox units; the bar takes BAR of it. */
const SLOT = 10;
const BAR = 7;

/** The smallest 1/2/5 × 10^k at or above v (0 → 0). */
export function niceCeil(v: number): number {
	if (!(v > 0)) return 0;
	const p = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 2, 5, 10]) if (m * p >= v - 1e-12) return m * p;
	return 10 * p;
}

/** Axis money: "$0.125", "$2.5", "$10" (three significant digits at most). */
function axisUsd(v: number): string {
	return `$${+v.toPrecision(3)}`;
}

function y(v: number, max: number): number {
	return PLOT_H - (v / max) * (PLOT_H - TOP);
}

const monthName = (month: string, style: "short" | "long") => {
	const [yy, mm] = month.split("-").map(Number);
	// en-US: "Sep", not en-GB's four-letter "Sept".
	return new Intl.DateTimeFormat("en-US", {
		month: style,
		...(style === "long" && { year: "numeric" }),
		timeZone: "UTC",
	}).format(new Date(Date.UTC(yy ?? 1970, (mm ?? 1) - 1, 1)));
};

export function formatMonth(month: string): string {
	return monthName(month, "long");
}

function daysIn(month: string): number {
	const [yy, mm] = month.split("-").map(Number);
	return new Date(Date.UTC(yy ?? 1970, mm ?? 1, 0)).getUTCDate();
}

/** The value axis + plot frame both charts share: labels in a left gutter,
 *  muted gridlines at half and full scale, a firmer baseline. */
function Plot({
	max,
	slots,
	ticks,
	children,
	label,
}: {
	max: number;
	slots: number;
	/** [slot index, text, minor] under the plot; a minor tick hides on a
	 *  phone-width dialog, where twelve month names would run together. */
	ticks: Array<[number, string, boolean?]>;
	children: React.ReactNode;
	label: string;
}) {
	const w = slots * SLOT;
	const grid = max > 0 ? [max / 2, max] : [];
	return (
		<div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 font-ui text-xs text-muted-foreground">
			<div className="relative" style={{ height: PLOT_H }} aria-hidden>
				{grid.map((v) => (
					<span key={v} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ top: y(v, max) }}>
						{axisUsd(v)}
					</span>
				))}
			</div>
			<svg
				role="img"
				aria-label={label}
				viewBox={`0 0 ${w} ${PLOT_H}`}
				preserveAspectRatio="none"
				className="block w-full overflow-visible"
				style={{ height: PLOT_H }}
			>
				{grid.map((v) => (
					<line
						key={v}
						x1={0}
						x2={w}
						y1={y(v, max)}
						y2={y(v, max)}
						stroke="var(--border)"
						strokeOpacity={0.6}
						strokeDasharray="2 3"
						vectorEffect="non-scaling-stroke"
					/>
				))}
				{children}
				<line x1={0} x2={w} y1={PLOT_H - 0.5} y2={PLOT_H - 0.5} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
			</svg>
			<div />
			<div className="relative mt-1 h-4" aria-hidden>
				{ticks.map(([i, text, minor]) => (
					<span key={i} className={`absolute -translate-x-1/2 whitespace-nowrap ${minor ? "max-sm:hidden" : ""}`} style={{ left: `${((i + 0.5) / slots) * 100}%` }}>
						{text}
					</span>
				))}
			</div>
		</div>
	);
}

/** The full-column hover target of slot i (a path, so it is never counted
 *  as a data <rect>). */
function HitPath({ i }: { i: number }) {
	return <path d={`M${i * SLOT} 0h${SLOT}v${PLOT_H}h${-SLOT}z`} fill="transparent" />;
}

/**
 * Daily spend for one month, one stacked bar per calendar day (Berlin days,
 * as the log folds them). A day without priced spend stays an empty column;
 * its tooltip says so. The legend lists the categories that appear.
 */
export function DailyBars({ days, month }: { days: UsageMonth["days"]; month: string }) {
	const n = daysIn(month);
	const byDay = new Map(days.map((d) => [d.day, d.byCategory]));
	const totals = days.map((d) => Object.values(d.byCategory).reduce((a, b) => a + (b ?? 0), 0));
	const max = niceCeil(Math.max(0, ...totals));
	const shortMonth = monthName(month, "short");
	const present = CATEGORY_ORDER.filter((c) => days.some((d) => (d.byCategory[c] ?? 0) > 0));
	const ticks: Array<[number, string]> = [1, 8, 15, 22, 29].filter((d) => d <= n).map((d) => [d - 1, String(d)]);
	return (
		<div data-testid="usage-daily-chart">
			<Plot max={max} slots={n} ticks={ticks} label={`Daily spend, ${formatMonth(month)}`}>
				{Array.from({ length: n }, (_, i) => {
					const key = `${month}-${String(i + 1).padStart(2, "0")}`;
					const split = byDay.get(key) ?? {};
					const parts = CATEGORY_ORDER.filter((c) => (split[c] ?? 0) > 0).map((c) => [c, split[c] ?? 0] as const);
					const total = parts.reduce((a, [, v]) => a + v, 0);
					const tip = parts.length
						? [`${i + 1} ${shortMonth} · ${costLabel(total)}`, ...parts.map(([c, v]) => `${CATEGORY_LABELS[c]} ${costLabel(v)}`)].join("\n")
						: `${i + 1} ${shortMonth} · no priced spend`;
					let top = PLOT_H;
					return (
						<g key={key} data-day={key}>
							<title>{tip}</title>
							<HitPath i={i} />
							{parts.map(([c, v], k) => {
								const h = (v / max) * (PLOT_H - TOP);
								top -= h;
								// Every segment but the top one gives GAP px back to the surface.
								const gap = k < parts.length - 1 && h > GAP * 2 ? GAP : 0;
								return (
									<rect
										key={c}
										x={i * SLOT + (SLOT - BAR) / 2}
										width={BAR}
										y={top + gap}
										height={Math.max(h - gap, 0.75)}
										fill={CATEGORY_COLORS[c]}
									/>
								);
							})}
						</g>
					);
				})}
			</Plot>
			{present.length > 0 && (
				<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-ui text-xs text-muted-foreground" data-testid="usage-legend">
					{present.map((c) => (
						<li key={c} className="flex items-center gap-1.5">
							<span className="size-2 rounded-[2px]" style={{ background: CATEGORY_COLORS[c] }} />
							{CATEGORY_LABELS[c]}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** "YYYY-MM" moved by `delta` calendar months. */
function shiftMonth(month: string, delta: number): string {
	const [yy, mm] = month.split("-").map(Number);
	const d = new Date(Date.UTC(yy ?? 1970, (mm ?? 1) - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Monthly totals over twelve contiguous calendar months ending at the
 * newest month with data (GET /api/usage/months lists only months that
 * have a log, so the gaps are filled here; older months fall off). One
 * neutral series; the selected month is drawn in the foreground ink. A
 * month without a log is an empty column that says "no requests"; an
 * unpriced month is an empty column with "—" (never $0).
 */
export function MonthBars({ months, selected }: { months: UsageMonthTotal[]; selected?: string }) {
	const newest = months.map((m) => m.month).sort().at(-1);
	if (!newest) return null;
	const byMonth = new Map(months.map((m) => [m.month, m]));
	const window = Array.from({ length: 12 }, (_, i) => shiftMonth(newest, i - 11));
	const max = niceCeil(Math.max(0, ...window.map((m) => byMonth.get(m)?.totalUsd ?? 0)));
	// Every other month name on a phone, counted back from the newest.
	const ticks: Array<[number, string, boolean]> = window.map((m, i) => [i, monthName(m, "short"), (11 - i) % 2 === 1]);
	return (
		<div data-testid="usage-month-chart">
			<Plot max={max} slots={12} ticks={ticks} label="Monthly spend">
				{window.map((month, i) => {
					const m = byMonth.get(month);
					const h = max > 0 && m?.totalUsd ? (m.totalUsd / max) * (PLOT_H - TOP) : 0;
					const tip = !m
						? `${formatMonth(month)} · no requests`
						: `${formatMonth(month)} · ${costLabel(m.totalUsd)}${m.unpricedCalls ? ` · ${m.unpricedCalls} calls unpriced` : ""}`;
					return (
						<g key={month} data-month={month}>
							<title>{tip}</title>
							<HitPath i={i} />
							{h > 0 && (
								<rect
									x={i * SLOT + (SLOT - BAR) / 2}
									width={BAR}
									y={PLOT_H - h}
									height={h}
									fill={month === selected ? "var(--foreground)" : "var(--muted-foreground)"}
								/>
							)}
						</g>
					);
				})}
			</Plot>
		</div>
	);
}
