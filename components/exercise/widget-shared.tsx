"use client";

import { GlyphMark } from "@/components/ui/glyph-mark";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { ItemVerdict } from "@/src/core";

/** What every per-format widget receives. `items` is the verdict's per-item
 *  marks keyed by (part-local) item id; `showExpected` is false for the
 *  marks-only view, where the key never reaches the DOM. */
export interface FormatWidgetProps {
	spec: unknown;
	value: unknown;
	onChange: (next: unknown) => void;
	items: Record<string, ItemVerdict>;
	showExpected: boolean;
	readOnly: boolean;
	toolCallId: string;
}

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export function valuesOf(value: unknown): Record<string, string> {
	const v = isRec(value) && isRec(value.values) ? value.values : {};
	const out: Record<string, string> = {};
	for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
	return out;
}

/** Inline markdown (labels, given cells, prose around a blank). */
export function Inline({ children, className }: { children: string; className?: string }) {
	return (
		<ToolContentResponse className={cn("inline [&>p]:m-0 [&>p]:inline", className)}>{children}</ToolContentResponse>
	);
}

/** One answerable item: an input, its ✓/✗ mark and (full review only) the key. */
export function ItemInput({
	id,
	label,
	value,
	onChange,
	item,
	showExpected,
	readOnly,
	width = "w-28",
	placeholder,
	suffix,
	compact,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (v: string) => void;
	item?: ItemVerdict;
	showExpected: boolean;
	readOnly: boolean;
	width?: string;
	placeholder?: string;
	suffix?: string;
	/** Table cell: fill the cell, shrink freely, and overlay the mark in the input's corner. */
	compact?: boolean;
}) {
	const mark = item ? (item.correct ? "true" : "false") : undefined;
	return (
		<span
			data-item={id}
			data-correct={mark}
			className={cn(
				compact ? "relative flex w-full min-w-0 flex-col" : "mx-0.5 inline-flex items-center gap-1.5 align-baseline",
			)}
		>
			<input
				type="text"
				value={value}
				readOnly={readOnly}
				aria-label={label}
				placeholder={placeholder}
				autoComplete="off"
				autoCapitalize="off"
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				className={cn(
					"lh-input min-w-0 rounded-md border bg-background/60 px-2 py-1 text-sm outline-none transition-colors focus:border-primary/60",
					width,
					compact && "w-full pr-6",
					mark === "true" && "border-green-500/60 bg-green-500/10",
					mark === "false" && "border-red-500/60 bg-red-500/10",
				)}
			/>
			{suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
			{item && (
				<span
					aria-hidden
					data-mark={item.correct ? "check" : "x"}
					className={cn("flex shrink-0", compact && "pointer-events-none absolute right-1.5 top-2", item.correct ? "text-green-500" : "text-red-500")}
				>
					<GlyphMark kind={item.correct ? "check" : "x"} className="size-3.5" />
				</span>
			)}
			{showExpected && item && !item.correct && item.expected !== undefined && (
				<span data-testid="exercise-expected" className="text-xs text-muted-foreground">
					answer: <Inline>{item.expected}</Inline>
				</span>
			)}
		</span>
	);
}

/** Shown when Check found entries the grader cannot read (unreadableItems):
 *  the Check is refused and does not count as an attempt. */
export function UnreadableNotice({ count }: { count: number }) {
	if (count === 0) return null;
	return (
		<div data-testid="exercise-unreadable" role="status" className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
			Couldn't read {count === 1 ? "that entry" : `${count} entries`}. Write it like 1000, 2.5, 3*4, x^2 or sqrt(2). This Check didn't count.
		</div>
	);
}
