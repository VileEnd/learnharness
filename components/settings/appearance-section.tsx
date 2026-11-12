"use client";
/**
 * The Appearance + Graph sections (thin settings wave).
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and hand the delta back so the CSS
 * variables move IMMEDIATELY (the section's whole point — it must DO
 * something). Themes step 2 (2026-11-12, port of upstream's section): the
 * theme cards (./theme-cards.tsx: Default, Ivory, Follow system) sit on
 * top; the "Colours" block holds one hex override per theme colour (empty =
 * the theme's) for the theme ON SCREEN: overrides are stored per theme
 * (owner ruling 2026-11-12), so Ivory's grid never shows or edits Default's,
 * and under Follow system the grid edits whichever theme the device shows.
 * "Typography" holds the type knobs. Hex inputs commit on blur/Enter.
 *
 * Graph graying (owner, 2026-09-20) follows the graph viewer's render-panel
 * convention: the whole row dims when a parent is off (stored values
 * persist but resolve inert — the switch shows stored, the dim effective).
 *
 * Reading font (appearance wave, 2026-09-26, owner ruling): a searchable
 * dropdown of the user's INSTALLED fonts (FontMenuList over model-menu's
 * machine) fed by window.queryLocalFonts() where the browser offers it
 * (Chromium, secure context) — the enumeration is click-bound (the API
 * requires user activation), deduped to unique families, the factory
 * family excluded (the DEFAULT row is it). Where the API is absent → a small curated list
 * + a footer that says exactly that — never a fabricated system list.
 * The custom-family input inside the menu is the manual escape path.
 * Empty/unset keeps meaning Source Sans 3.
 *
 * Overrides live in `appearance.colors.<themeId>`; core/themes.ts
 * effectiveColors is the one place they merge onto a theme.
 */

import { useEffect, useRef, useState } from "react";
import {
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	EXTRACTION_DIGEST_TOKENS_FLOOR,
	resolveSettings,
	THEME_COLOR_KEYS,
	type AppearanceSettings,
	type GraphSettings,
	type ThemeColorKey,
	type ThemeId,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { BUNDLED_READING_FONTS, useAppearance } from "./appearance.tsx";
import { FontMenuList } from "./model-menu";
import { CommitInput, SettingsRow, Toggle } from "./controls.tsx";
import { ThemeCards } from "./theme-cards.tsx";

/** The factory reading family — the DEFAULT row's identity (unset =
 *  this). Exported for tests. */
export const DEFAULT_READING_FONT = "Source Sans 3";

/** The dev-browser fallback list (queryLocalFonts is absent there):
 *  the app's own knowns plus a handful of ubiquitous macOS families,
 *  honestly LABELED as common — never presented as the system's real
 *  list. The factory family is absent: the DEFAULT row is it. Exported
 *  for tests. */
export const CURATED_FALLBACK_FONTS: readonly string[] = [
	"Arial",
	"CMU Serif",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Helvetica Neue",
	"JetBrains Mono",
	"Menlo",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

/** window.queryLocalFonts' shape as this section consumes it (family is
 *  the only field used; the API returns one FontData per FACE — the
 *  caller dedupes). */
type LocalFontsApi = () => Promise<Array<{ family: string }>>;

/** The Local Font Access seam — read lazily (SSR has no window, and
 *  render-time access would evaluate the API on the server). */
function localFontsApi(): LocalFontsApi | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { queryLocalFonts?: LocalFontsApi }).queryLocalFonts ?? null;
}

/** The menu list from the OS-reported families: the bundled families join
 *  them (they render whether or not the OS has them), but only when the OS
 *  list was actually read; deduped, default row removed, sorted. Pure. */
export function installedFontFamilies(installed: readonly string[]): string[] {
	return [...new Set(installed.length ? [...installed, ...Object.keys(BUNDLED_READING_FONTS)] : [])]
		.filter((f) => f !== DEFAULT_READING_FONT)
		.sort((a, b) => a.localeCompare(b));
}

/** Compose the reading-font pick: null (or blank) = the factory
 *  Source Sans 3; otherwise the family verbatim (trimmed — the
 *  sanitizer trims again server-side). Pure — exported for tests. */
export function composeFontFamily(
	appearance: AppearanceSettings | undefined,
	family: string | null,
): AppearanceSettings {
	const value = family?.trim() ?? "";
	return { ...appearance, fontFamily: value === "" ? null : value };
}

/** The Colours grid's labels and the one hint that explains a key. */
const COLOR_LABELS: Record<ThemeColorKey, { label: string; note?: string }> = {
	background: { label: "Background" },
	accent: { label: "Accent", note: "Focus rings, toggles, selection" },
	surface: { label: "Surface", note: "Cards, inputs, sidebar" },
	bold: { label: "Bold" },
	border: { label: "Border" },
	italic: { label: "Italic" },
	text: { label: "Text" },
	code: { label: "Inline code" },
	textMuted: { label: "Muted text" },
	error: { label: "Error" },
	success: { label: "Success" },
	warning: { label: "Warning" },
};

/** The legacy test ids of the three pre-theme rows (kept stable). */
const LEGACY_TESTIDS: Partial<Record<ThemeColorKey, string>> = {
	background: "input-background",
	bold: "input-bold-color",
	italic: "input-italic-color",
};

/** The stored override for one colour of one theme ("" = none). Pure —
 *  exported for tests. */
export function colorOverride(appearance: AppearanceSettings | undefined, themeId: ThemeId, key: ThemeColorKey): string {
	return appearance?.colors?.[themeId]?.[key] ?? "";
}

/** Compose one override into one theme's set ("" = back to the theme's).
 *  The other theme's overrides and every other field ride along untouched.
 *  Pure — exported for tests. */
export function composeColorOverride(
	appearance: AppearanceSettings | undefined,
	themeId: ThemeId,
	key: ThemeColorKey,
	value: string,
): AppearanceSettings {
	const own = { ...appearance?.colors?.[themeId] };
	if (value === "") delete own[key];
	else own[key] = value;
	return { ...appearance, colors: { ...appearance?.colors, [themeId]: own } };
}

/** "Reset all": every colour of ONE theme back to the theme's; the other
 *  theme's overrides, the type knobs and the choice untouched. Pure —
 *  exported for tests. */
export function clearColorOverrides(appearance: AppearanceSettings | undefined, themeId: ThemeId): AppearanceSettings {
	const { [themeId]: _cleared, ...others } = appearance?.colors ?? {};
	return { ...appearance, colors: others };
}

function ColorOverrideRow({
	colorKey,
	value,
	themeColor,
	effective,
	onCommit,
}: {
	colorKey: ThemeColorKey;
	value: string;
	themeColor: string;
	effective: string;
	onCommit: (next: string) => void;
}) {
	const { label, note } = COLOR_LABELS[colorKey];
	// Default's status colours are oklch (exact Tailwind 4 values): named, not printed.
	const empty = themeColor.startsWith("#") ? `Empty = ${themeColor}` : "Empty = the theme's";
	return (
		<SettingsRow label={label} hint={note ? `${note} · ${empty}` : empty} testid={`row-color-${colorKey}`}>
			<span className="flex items-center gap-2">
				<span
					aria-hidden
					data-testid={`swatch-${colorKey}`}
					className="size-4 shrink-0 rounded-sm border border-border"
					style={{ background: effective }}
				/>
				<CommitInput
					value={value}
					placeholder={themeColor.startsWith("#") ? themeColor : "theme"}
					ariaLabel={`${label.toLowerCase()} hex`}
					testid={LEGACY_TESTIDS[colorKey] ?? `input-color-${colorKey}`}
					onCommit={onCommit}
				/>
			</span>
		</SettingsRow>
	);
}

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved, choice, activeTheme, colors } = useAppearance();
	const md = appearance?.mdRendering;

	// The font dropdown's open state + its enumeration cache. undefined =
	// not enumerated yet (click-bound queryLocalFonts pending);
	// null = enumeration UNAVAILABLE (the API is absent in this browser,
	// rejected, or resolved EMPTY) → the curated fallback; a list = the deduped
	// families. enumEmpty distinguishes WHY it fell back, for the footer.
	const [fontMenuOpen, setFontMenuOpen] = useState(false);
	const [localFonts, setLocalFonts] = useState<string[] | null | undefined>(undefined);
	const [enumEmpty, setEnumEmpty] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	// The enumeration runs INSIDE the trigger click — queryLocalFonts
	// requires user activation, so it cannot be a mount effect. First
	// open only: the families are cached for the section's life (font
	// installs mid-dialog are not a case); ANY unavailable enumeration
	// (absent / rejected / empty) falls back to the curated list rather
	// than an empty picker.
	const openFontMenu = () => {
		setFontMenuOpen((open) => {
			if (!open && localFonts === undefined) {
				const api = localFontsApi();
				if (api === null) {
					setLocalFonts(null);
					setEnumEmpty(false);
				} else {
					void api()
						.then((fonts) => {
							const families = installedFontFamilies(fonts.map((f) => f.family));
							if (families.length === 0) {
								// Resolved-but-empty: not a failure the catch sees —
								// an honest unavailable.
								setLocalFonts(null);
								setEnumEmpty(true);
							} else {
								setLocalFonts(families);
							}
						})
						.catch(() => {
							setLocalFonts(null);
							setEnumEmpty(false);
						});
				}
			}
			return !open;
		});
	};

	const pickFont = (family: string | null) => {
		setFontMenuOpen(false);
		onSectionChange(composeFontFamily(appearance, family));
	};

	// The dropdown contract (agent-section's, mirrored): any click
	// outside the open menu — or an Esc — closes it. Esc is CLAIMED with
	// stopPropagation so the settings dialog behind does NOT also close.
	useEffect(() => {
		if (!fontMenuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setFontMenuOpen(false);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setFontMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [fontMenuOpen]);

	return (
		<>
			<ThemeCards choice={choice} onSelect={(next) => onSectionChange({ ...appearance, theme: next })} />
			<div data-testid="group-colors" className="mt-5 flex flex-col gap-2">
				<div className="flex items-end justify-between gap-4">
					<p className="text-xs uppercase tracking-widest text-muted-foreground">
						Colours{" "}
						<span data-testid="colors-theme" className="normal-case tracking-normal text-muted-foreground-70">
							· {activeTheme.name}&apos;s own overrides
							{choice === "system" ? " (the theme on screen now)" : ""}
						</span>
					</p>
					<button
						type="button"
						data-testid="colors-reset"
						onClick={() => onSectionChange(clearColorOverrides(appearance, activeTheme.id))}
						className="h-6 shrink-0 rounded-sm px-2 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						Reset all
					</button>
				</div>
				<div className="grid grid-cols-1 gap-x-10 gap-y-2 lg:grid-cols-2">
					{THEME_COLOR_KEYS.map((key) => (
						<ColorOverrideRow
							key={key}
							colorKey={key}
							value={colorOverride(appearance, activeTheme.id, key)}
							themeColor={activeTheme.colors[key]}
							effective={colors[key]}
							onCommit={(v) => onSectionChange(composeColorOverride(appearance, activeTheme.id, key, v))}
						/>
					))}
				</div>
			</div>
			<p className="mt-5 mb-2 text-xs uppercase tracking-widest text-muted-foreground">Typography</p>
			<SettingsRow
				label="Reading font"
				hint={`Empty = ${DEFAULT_READING_FONT}`}
				testid="row-font"
			>
				<span ref={fontMenuOpen ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
					{/* The MenuTrigger look (agent-section's collapsed
					    select — it lives unexported there, so the
					    classes ride inline; the searchable machine is
					    the shared part). The tooltip rides the CLOSED
					    button ONLY (owner ruling 2026-09-26: never while
					    the dropdown is out — it popped over the open
					    menu when the wrap covered the whole anchor
					    span). */}
					{(() => {
						const triggerButton = (
							<button
								type="button"
								aria-label="Reading font"
								aria-expanded={fontMenuOpen}
								data-testid="font-trigger"
								onClick={openFontMenu}
								className="flex h-7 min-w-20 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
							>
								<span className="min-w-0 flex-1 truncate">{appearance?.fontFamily || DEFAULT_READING_FONT}</span>
								<span aria-hidden className="text-muted-foreground">
									▾
								</span>
							</button>
						);
						return fontMenuOpen ? (
							triggerButton
						) : (
							<Hint label="Choose from your installed fonts" side="left">
								{triggerButton}
							</Hint>
						);
					})()}
					{fontMenuOpen && (
						<MenuShell
							preferredSide="down"
							anchorTestid="font-trigger"
							testid="font-menu"
							menuClass="flex w-[18rem] flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
						>
							<FontMenuList
								families={localFonts === undefined ? undefined : (localFonts ?? [...CURATED_FALLBACK_FONTS])}
								effectiveFamily={appearance?.fontFamily ?? null}
								onPick={pickFont}
								footer={
									localFonts === undefined
										? undefined
										: localFonts === null
											? enumEmpty
												? "Common families — installed fonts could not be read"
												: "Common families — this browser can't list installed fonts"
											: "Your installed fonts"
								}
							/>
						</MenuShell>
					)}
				</span>
			</SettingsRow>
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="16"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): omit the key so the record
						// UNSETS and the field stays empty (absence, not null, is the
						// unset for numbers). Number("") is 0, so the old clamp wrote 12.
						if (v === "") {
							onSectionChange({ ...appearance, proseFontSize: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Session names in serif" testid="row-session-serif">
				<Toggle
					checked={appearance?.sessionNameSerif ?? true}
					label="session names serif"
					onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="900"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): Number("") is 0, so
						// Absence is the unset representation — the old clamp wrote 100.
						if (v === "") {
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	// Wave 7 collapse (owner ruling 2026-09-23): the section is the MASTER
	// SWITCH — the embedding/clustering/labeling rungs are gone; clustering
	// is the free birth-session partition derived on read, labels ARE session
	// names. The chunk budget (2026-10-02) joined it as the section's second
	// and only other control: it denominates the coverage ring AND gates the
	// auto-extraction trigger (turn settle ≥ budget fires the run).
	//
	// Resolved through the SAME core resolver the server's effective
	// settings use (one source of truth, the 4096-fallback fix 2026-10-02):
	// the hint and placeholder report exactly the number the trigger waits
	// for — never a second hand-rolled default.
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			{/* EXTRACTION (renamed, owner 2026-10-06): this switch is the DATA
			    channel — the pipeline, the auditor, the prober's graph tools. It
			    was born labeled "Graph" and that label lied once the rendering
			    switch below arrived: off ≠ no graph, off = the graph stops
			    growing. The testid keeps the old name's shape (row-enabled) so
			    this stays one rename, not a test re-pin. */}
			<SettingsRow label="Extraction" hint="Off = the graph stops growing" testid="graph-row-enabled">
				<Toggle
					checked={graph?.enabled ?? true}
					label="extraction enabled"
					onChange={(on) =>
						// Compose, never replace-whole (the section PUT is, but the
					// row must not drop its sibling field — fixed with the budget
					// row's arrival: the old { enabled: on } wiped a stored budget).
						onSectionChange({ ...graph, enabled: on })
					}
				/>
			</SettingsRow>
			{/* GRAPH RENDERING (owner, 2026-10-06 — the release graph-controls
			    round): display-only. Off = the home shows the chains view
			    instead of the canvas. The ledgers, the pipeline, everything
			    data keeps working — that is the extraction switch above. */}
			<SettingsRow label="Graph rendering" hint="Off = home shows the chains view" testid="graph-row-rendering">
				<Toggle
					checked={graph?.rendering ?? true}
					label="graph rendering enabled"
					onChange={(on) => onSectionChange({ ...graph, rendering: on })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Extraction chunk budget"
				hint={`${resolved.extractionChunkTokens} tok`}
				testid="graph-row-chunk-tokens"
			>
				<CommitInput
					type="number"
					value={String(graph?.extractionChunkTokens ?? "")}
					placeholder={String(resolved.extractionChunkTokens)}
					ariaLabel="extraction chunk budget"
					testid="input-chunk-tokens"
					onCommit={(v) => {
						// Empty = factory default (the fix-wave discipline): absence is
						// the unset for numbers — Number("") is 0, so clamping would
						// write the floor instead of unsetting.
						if (v === "") {
							onSectionChange({ ...graph, extractionChunkTokens: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
						// Mirror the server sanitize exactly: floor only (cost
						// protection), no ceiling — a big budget is the user's call.
						onSectionChange({
							...graph,
							extractionChunkTokens: Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n)),
						});
					}}
				/>
			</SettingsRow>
			{/* THE DIGEST BUDGET (audit B4, owner 2026-11-12): the ceiling of the
			    earlier ideas each chunk's prompt carries. Same commit discipline
			    as the chunk budget above: empty = factory, floor only. */}
			<SettingsRow
				label="Extraction digest budget"
				hint={`${resolved.extractionDigestTokens} tok`}
				testid="graph-row-digest-tokens"
			>
				<CommitInput
					type="number"
					value={String(graph?.extractionDigestTokens ?? "")}
					placeholder={String(resolved.extractionDigestTokens)}
					ariaLabel="extraction digest budget"
					testid="input-digest-tokens"
					onCommit={(v) => {
						if (v === "") {
							onSectionChange({ ...graph, extractionDigestTokens: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
						onSectionChange({
							...graph,
							extractionDigestTokens: Math.max(EXTRACTION_DIGEST_TOKENS_FLOOR, Math.round(n)),
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}