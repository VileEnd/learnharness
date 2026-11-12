"use client";
/**
 * THE THEME PICKER (themes step 2, port of upstream's theme-cards.tsx): one
 * card per choice: Default, Ivory and Follow system. No import or export
 * (owner ruling 2026-11-12), so the grid is the three cards only.
 *
 * Each card previews with literal colours (never the page's live tokens):
 * an "Aa ai" sample on the theme background (text + accent ink) and three
 * dots (surface, error, success). Follow system shows both presets, split.
 * Picking a card only changes `appearance.theme`; each preset keeps its own
 * overrides, and the page shows the picked one's.
 */

import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_THEME, IVORY_THEME, type Theme, type ThemeChoice } from "@/src/core";

/** The selected card's frame: a 2px gap in the dialog surface, then a 1px
 *  ring in the theme accent (the check by the name does the rest). */
const SELECTED_FRAME = "shadow-[0_0_0_2px_var(--card),0_0_0_3px_var(--lh-accent)]";

/** The cards, in grid order. Exported for tests. */
export const THEME_CARDS: readonly { choice: ThemeChoice; name: string; tag: string; themes: readonly Theme[] }[] = [
	{ choice: "default", name: DEFAULT_THEME.name, tag: "dark", themes: [DEFAULT_THEME] },
	{ choice: "ivory", name: IVORY_THEME.name, tag: "light", themes: [IVORY_THEME] },
	{ choice: "system", name: "Follow system", tag: "auto", themes: [IVORY_THEME, DEFAULT_THEME] },
];

function Dot({ color, edge }: { color: string; edge?: string }) {
	return (
		<span
			aria-hidden
			className="size-2.5 shrink-0 rounded-full"
			style={{ background: color, ...(edge ? { border: `1px solid ${edge}` } : {}) }}
		/>
	);
}

/** One preset's miniature: never reads the page tokens. */
function Swatch({ theme }: { theme: Theme }) {
	const c = theme.colors;
	return (
		<span className="flex min-w-0 flex-1 items-center justify-between gap-1 px-2" style={{ background: c.background }}>
			<span className="font-prose text-lg font-semibold" style={{ color: c.text }}>
				Aa <i className="font-normal" style={{ color: c.accent }}>ai</i>
			</span>
			<span className="flex gap-1 max-sm:hidden">
				<Dot color={c.surface} edge={c.border} />
				<Dot color={c.error} />
				<Dot color={c.success} />
			</span>
		</span>
	);
}

/** The Theme row of Settings → Appearance. */
export function ThemeCards({ choice, onSelect }: { choice: ThemeChoice; onSelect: (choice: ThemeChoice) => void }) {
	return (
		<div data-testid="row-theme" className="flex flex-col gap-3 py-1">
			<span className="min-w-0">
				<span className="block font-prose text-(length:--lh-prose-size)">Theme</span>
				<span data-testid="theme-hint" className="block text-xs text-muted-foreground-70">
					Sets every colour below · Follow system switches with your device
				</span>
			</span>
			<div className="grid grid-cols-3 gap-2 sm:gap-3">
				{THEME_CARDS.map((card) => {
					const selected = card.choice === choice;
					return (
						<button
							key={card.choice}
							type="button"
							data-testid={`theme-card-${card.choice}`}
							aria-pressed={selected}
							onClick={() => onSelect(card.choice)}
							className={cn(
								"flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-2 text-left transition-colors sm:p-3",
								selected ? SELECTED_FRAME : "hover:border-muted-foreground/50",
							)}
						>
							<span
								aria-hidden
								className="flex h-10 overflow-hidden rounded-md border"
								style={{ borderColor: card.themes[0]!.colors.border }}
							>
								{card.themes.map((t) => (
									<Swatch key={t.id} theme={t} />
								))}
							</span>
							<span className="flex flex-wrap items-center justify-between gap-1">
								<span className="flex min-w-0 items-center gap-1.5 font-prose text-base">
									{selected && <CheckIcon className="size-3.5 shrink-0" strokeWidth={2.5} />}
									<span className="truncate">{card.name}</span>
								</span>
								<span className="shrink-0 rounded-sm border border-border px-1.5 font-ui text-xs uppercase tracking-wider text-muted-foreground">
									{card.tag}
								</span>
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
