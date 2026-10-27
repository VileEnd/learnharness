"use client";

import { ItemInput, isRec, type FormatWidgetProps } from "./widget-shared.tsx";

export function NumericWidget({ spec, value, onChange, items, showExpected, readOnly }: FormatWidgetProps) {
	const unit = isRec(spec) && typeof spec.unit === "string" ? spec.unit : undefined;
	const text = isRec(value) && typeof value.value === "string" ? value.value : "";
	return (
		<div data-testid="exercise-numeric" className="flex flex-wrap items-center gap-1 py-1">
			<ItemInput
				id="answer"
				label="Your answer"
				value={text}
				onChange={(v) => onChange({ value: v })}
				item={items.answer}
				showExpected={showExpected}
				readOnly={readOnly}
				width="w-40"
				placeholder="Your answer"
				suffix={unit}
			/>
		</div>
	);
}
