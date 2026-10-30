"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fuzzyScore } from "@/src/core";

/** The model picker's search, arrow-walk, row styling and scrolling machine.
 * Models and dictation languages supply only their catalog and row content.
 * The caller owns the shared MenuShell and dismissal behavior.
 *
 * `pinned` (the model picker's Recommended group) returns rows shown above
 * the ranked list for the current query; they walk first and may repeat an
 * item that also appears in the list. */
export function SearchMenuList<T>({
	items, itemKey, searchTerms, compare, isSelected, onPick, renderItem,
	searchTestid, listTestid, optionTestid, placeholder, ariaLabel, loading, empty,
	disabled = false, pinned, pinnedLabel, pinnedLabelTestid, pinnedOptionTestid, renderPinned,
}: {
	items: readonly T[] | undefined;
	itemKey: (item: T) => string;
	searchTerms: (item: T) => string[];
	compare?: (a: T, b: T) => number;
	isSelected: (item: T) => boolean;
	onPick: (item: T) => void;
	renderItem: (item: T) => ReactNode;
	searchTestid: string;
	listTestid: string;
	optionTestid: (item: T) => string;
	placeholder: string;
	ariaLabel?: string;
	loading?: string;
	empty: string;
	disabled?: boolean;
	pinned?: (query: string) => readonly T[];
	pinnedLabel?: string;
	pinnedLabelTestid?: string;
	pinnedOptionTestid?: (item: T) => string;
	renderPinned?: (item: T) => ReactNode;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	// Focus on mount, and again whenever the input becomes enabled (settings
	// finished loading, or a failed save released it): a disabled input drops focus.
	useEffect(() => { if (!disabled) searchRef.current?.focus(); }, [disabled]);
	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const list = (items ?? [])
		.map((item) => ({ item, score: fuzzyScore(query, ...searchTerms(item)) }))
		.filter((result) => result.score !== null)
		.sort((a, b) => b.score! - a.score! || (compare?.(a.item, b.item) ?? 0))
		.map(({ item }) => item);
	const group = pinned?.(query) ?? [];
	// One linear walkable array: pinned rows first, then list rows.
	const results = [...group, ...list];

	const rowClass = (item: T, i: number) =>
		`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
			i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
		}${isSelected(item) && i !== menuIdx ? " bg-muted/60" : ""}`;

	return <>
		<input
			type="text"
			ref={searchRef}
			data-testid={searchTestid}
			aria-label={ariaLabel}
			value={query}
			disabled={disabled}
			onChange={(event) => { setQuery(event.target.value); setMenuIdx(null); }}
			onKeyDown={(event) => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					event.stopPropagation();
					if (disabled || results.length === 0) return;
					setMenuIdx((i) => event.key === "ArrowDown"
						? Math.min((i ?? -1) + 1, results.length - 1)
						: Math.max((i ?? results.length) - 1, 0));
				} else if (event.key === "Enter") {
					const chosen = results[menuIdx ?? 0];
					if (!disabled && chosen !== undefined) {
						event.preventDefault();
						event.stopPropagation();
						onPick(chosen);
					}
				}
			}}
			placeholder={placeholder}
			className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
		/>
		{!items && loading && <div className="px-2 py-3 text-center text-muted-foreground">{loading}</div>}
		{items && results.length === 0 && <div className="px-2 py-3 text-center text-muted-foreground">{empty}</div>}
		<ul ref={listRef} data-testid={listTestid} className="flex max-h-72 flex-col overflow-y-auto px-1">
			{group.length > 0 && <>
				<li data-testid={pinnedLabelTestid} className="px-2 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
					{pinnedLabel}
				</li>
				{group.map((item, i) => <li key={`pin-${itemKey(item)}`}>
					<button
						type="button"
						data-testid={(pinnedOptionTestid ?? optionTestid)(item)}
						data-idx={i}
						disabled={disabled}
						onClick={() => onPick(item)}
						className={rowClass(item, i)}
					>{(renderPinned ?? renderItem)(item)}</button>
				</li>)}
				<li aria-hidden className="mx-2 my-1 border-t" />
			</>}
			{list.map((item, j) => {
				const i = group.length + j;
				return <li key={itemKey(item)}>
					<button
						type="button"
						data-testid={optionTestid(item)}
						data-idx={i}
						disabled={disabled}
						onClick={() => onPick(item)}
						className={rowClass(item, i)}
					>{renderItem(item)}</button>
				</li>;
			})}
		</ul>
	</>;
}
