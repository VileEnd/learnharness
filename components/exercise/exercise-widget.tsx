"use client";

import type { ExerciseVerdict, InteractiveFormat, ItemVerdict } from "@/src/core";
import { BlanksWidget } from "./blanks-widget.tsx";
import { MultipartWidget } from "./multipart-widget.tsx";
import { NumericWidget } from "./numeric-widget.tsx";
import { TableWidget } from "./table-widget.tsx";
import type { FormatWidgetProps } from "./widget-shared.tsx";

export interface ExerciseWidgetProps {
	format: InteractiveFormat;
	spec: unknown;
	toolCallId: string;
	/** The learner's response (format-shaped). */
	value: unknown;
	onChange: (next: unknown) => void;
	/** Per-item marks. Without `marksOnly` this is the answered view: the
	 *  expected value shows beside every wrong item. */
	review?: ExerciseVerdict;
	/** Show only ✓/✗, never `expected` (the key stays out of the DOM). */
	marksOnly?: boolean;
	/** No inputs to edit (the answered card, the answer key). */
	readOnly?: boolean;
}

/** Dispatch to the per-format widget. */
export function FormatSwitch(props: FormatWidgetProps & { format: InteractiveFormat }) {
	switch (props.format) {
		case "numeric":
			return <NumericWidget {...props} />;
		case "blanks":
			return <BlanksWidget {...props} />;
		case "table":
			return <TableWidget {...props} />;
		case "multipart":
			return <MultipartWidget {...props} />;
		default:
			return null;
	}
}

export function ExerciseWidget({ format, spec, toolCallId, value, onChange, review, marksOnly = false, readOnly = false }: ExerciseWidgetProps) {
	const items: Record<string, ItemVerdict> = {};
	for (const it of review?.items ?? []) {
		items[it.id] = marksOnly ? { id: it.id, correct: it.correct, ...(it.given !== undefined ? { given: it.given } : {}) } : it;
	}
	return (
		<FormatSwitch
			format={format}
			spec={spec}
			toolCallId={toolCallId}
			value={value}
			onChange={onChange}
			items={items}
			showExpected={!marksOnly}
			readOnly={readOnly}
		/>
	);
}
