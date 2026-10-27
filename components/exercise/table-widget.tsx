"use client";

import { Inline, ItemInput, isRec, valuesOf, type FormatWidgetProps } from "./widget-shared.tsx";

/** Given cells are read-only text; editable cells are inputs. Tab walks the
 *  inputs in document order (the only focusable cells), row by row. */
export function TableWidget({ spec, value, onChange, items, showExpected, readOnly }: FormatWidgetProps) {
	const columns = isRec(spec) && Array.isArray(spec.columns) ? (spec.columns as string[]) : [];
	const rows = isRec(spec) && Array.isArray(spec.rows) ? (spec.rows as { cells: Record<string, unknown>[] }[]) : [];
	const vals = valuesOf(value);
	return (
		<div data-testid="exercise-table" className="overflow-x-auto py-1">
			<table className="w-full table-fixed border-collapse text-sm">
				<thead>
					<tr>
						{columns.map((c, i) => (
							<th key={i} className="border-b px-1 py-1.5 text-left sm:px-2 text-xs font-medium text-muted-foreground">
								<Inline>{c}</Inline>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, ri) => (
						<tr key={ri}>
							{row.cells.map((cell, ci) => (
								<td key={ci} className="min-w-0 border-b px-1 py-1.5 align-middle sm:px-2">
									{typeof cell.given === "string" ? (
										<Inline>{cell.given}</Inline>
									) : typeof cell.id === "string" ? (
										<ItemInput
											id={cell.id}
											label={`${columns[ci] ?? "Column " + (ci + 1)}, row ${ri + 1}`}
											value={vals[cell.id] ?? ""}
											onChange={(v) => onChange({ values: { ...vals, [cell.id as string]: v } })}
											item={items[cell.id]}
											showExpected={showExpected}
											readOnly={readOnly}
											width="w-24 min-w-0"
											compact
										/>
									) : null}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
