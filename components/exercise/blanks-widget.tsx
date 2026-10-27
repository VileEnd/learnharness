"use client";

import { Inline, ItemInput, isRec, valuesOf, type FormatWidgetProps } from "./widget-shared.tsx";

/** Split a blanks text into prose segments and placeholder ids. */
export function splitBlanks(text: string): { prose: string; id?: string }[] {
	const out: { prose: string; id?: string }[] = [];
	let last = 0;
	for (const m of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
		out.push({ prose: text.slice(last, m.index), id: m[1]!.trim() });
		last = m.index + m[0].length;
	}
	out.push({ prose: text.slice(last) });
	return out;
}

export function BlanksWidget({ spec, value, onChange, items, showExpected, readOnly }: FormatWidgetProps) {
	const text = isRec(spec) && typeof spec.text === "string" ? spec.text : "";
	const vals = valuesOf(value);
	return (
		<div data-testid="exercise-blanks" className="lh-prose py-1 leading-9">
			{splitBlanks(text).map((seg, i) => (
				<span key={i}>
					{seg.prose && <Inline>{seg.prose}</Inline>}
					{seg.id !== undefined && (
						<ItemInput
							id={seg.id}
							label={`Blank ${seg.id}`}
							value={vals[seg.id] ?? ""}
							onChange={(v) => onChange({ values: { ...vals, [seg.id!]: v } })}
							item={items[seg.id]}
							showExpected={showExpected}
							readOnly={readOnly}
						/>
					)}
				</span>
			))}
		</div>
	);
}
