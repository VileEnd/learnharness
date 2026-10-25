"use client";

import type { GraphGroupBy } from "@/src/core";

/**
 * "Group by: Source · Topic" - the graph's clustering switch (render
 * setting `groupBy`). One component for both homes: the graph settings gear
 * panel and the chain-table header. A two-button radio group; touch targets
 * grow on coarse pointers.
 */
export function GroupByToggle({
	value,
	onChange,
	className = "",
}: {
	value: GraphGroupBy;
	onChange: (next: GraphGroupBy) => void;
	className?: string;
}) {
	const option = (id: GraphGroupBy, label: string) => (
		<button
			key={id}
			type="button"
			role="radio"
			aria-checked={value === id}
			data-testid={`group-by-${id}`}
			onClick={() => onChange(id)}
			className={
				"px-2 py-0.5 text-[11px] transition-colors pointer-coarse:min-h-9 pointer-coarse:px-3 " +
				(value === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")
			}
		>
			{label}
		</button>
	);
	return (
		<div data-testid="group-by" className={`flex shrink-0 items-center gap-2 text-[11px] normal-case tracking-normal text-muted-foreground ${className}`}>
			<span>Group by</span>
			<div role="radiogroup" aria-label="Group by" className="flex divide-x divide-border/70 overflow-hidden rounded-md border border-border/70">
				{option("source", "Source")}
				{option("topic", "Topic")}
			</div>
		</div>
	);
}
