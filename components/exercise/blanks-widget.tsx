"use client";

import { Inline, ItemInput, isRec, valuesOf, type FormatWidgetProps } from "./widget-shared.tsx";

const BLANK = /\{\{([^{}]+)\}\}/g;
const TRAILING_BLANKS = /^(\$\$?)([\s\S]*?)((?:\s*\{\{[^{}]+\}\})+)\s*(\$\$?)$/;
const MATH_SPAN = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g;

/**
 * Split a blanks text into segments: prose followed by the ids of the inputs
 * that belong after it. A blank inside a `$...$` / `$$...$$` math span cannot
 * be cut out of the span (the fragments would not render as KaTeX), so the span
 * stays whole; trailing blanks move out of it (their inputs follow the span) and
 * blanks inside it become a thin invisible gap.
 */
export function splitBlanks(text: string): { prose: string; ids: string[] }[] {
	const out: { prose: string; ids: string[] }[] = [];
	let pending = "";
	const addProse = (chunk: string) => {
		let last = 0;
		for (const m of chunk.matchAll(BLANK)) {
			out.push({ prose: pending + chunk.slice(last, m.index), ids: [m[1]!.trim()] });
			pending = "";
			last = m.index + m[0].length;
		}
		pending += chunk.slice(last);
	};
	let last = 0;
	for (const m of text.matchAll(MATH_SPAN)) {
		addProse(text.slice(last, m.index));
		last = m.index + m[0].length;
		const tail = m[0].match(TRAILING_BLANKS);
		const body = tail ? tail[1]! + tail[2]!.trim() + tail[4]! : m[0];
		const ids = [...m[0].matchAll(BLANK)].map((b) => b[1]!.trim());
		if (ids.length === 0) pending += m[0];
		else {
			// A trailing blank leaves the span so its input sits exactly there;
			// a blank mid-span becomes a thin invisible gap (never a box glyph).
			const kept = tail && tail[2]!.trim() === "" ? "" : body.replace(BLANK, "\\,");
			out.push({ prose: pending + kept, ids });
			pending = "";
		}
	}
	addProse(text.slice(last));
	if (pending) out.push({ prose: pending, ids: [] });
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
					{seg.ids.map((id) => (
						<ItemInput
							key={id}
							id={id}
							label={`Blank ${id}`}
							value={vals[id] ?? ""}
							onChange={(v) => onChange({ values: { ...vals, [id]: v } })}
							item={items[id]}
							showExpected={showExpected}
							readOnly={readOnly}
						/>
					))}
				</span>
			))}
		</div>
	);
}
