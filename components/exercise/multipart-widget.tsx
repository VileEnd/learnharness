"use client";

import type { InteractiveFormat, ItemVerdict } from "@/src/core";
import { FormatSwitch } from "./exercise-widget.tsx";
import { Inline, isRec, type FormatWidgetProps } from "./widget-shared.tsx";

/** Labelled sections that each render the child widget; part verdicts are
 *  the items whose id starts with `<partId>.`. */
export function MultipartWidget({ spec, value, onChange, items, showExpected, readOnly, toolCallId }: FormatWidgetProps) {
	const parts = isRec(spec) && Array.isArray(spec.parts) ? (spec.parts as Record<string, unknown>[]) : [];
	const responses = isRec(value) && isRec(value.parts) ? value.parts : {};
	return (
		<div data-testid="exercise-multipart" className="flex flex-col gap-3 py-1">
			{parts.map((part) => {
				const id = String(part.id);
				const prefix = `${id}.`;
				const own: Record<string, ItemVerdict> = {};
				for (const [k, it] of Object.entries(items)) if (k.startsWith(prefix)) own[k.slice(prefix.length)] = { ...it, id: k.slice(prefix.length) };
				return (
					<section key={id} data-part={id} className="rounded-lg border bg-background/40 px-3 py-2">
						<div className="mb-1 text-sm font-medium">
							<Inline>{String(part.label ?? "")}</Inline>
						</div>
						<FormatSwitch
							format={part.format as InteractiveFormat}
							spec={part.spec}
							value={responses[id]}
							onChange={(next) => onChange({ parts: { ...responses, [id]: next } })}
							items={own}
							showExpected={showExpected}
							readOnly={readOnly}
							toolCallId={`${toolCallId}:${id}`}
						/>
					</section>
				);
			})}
		</div>
	);
}
