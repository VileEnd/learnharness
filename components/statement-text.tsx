"use client";

import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";

/**
 * The text of a proposition, a concept name or a learner note, shown where a
 * learner reads statements on the HOME route (the graph card, the chains
 * rows, "My knowledge"): Markdown and math through the app's one sanitised
 * pipeline, in the surface's own small type.
 *
 * This module is deliberately light. The renderer (Streamdown, KaTeX, the
 * code and math plugins, the mermaid loader) is about 0.7 MB of first-load
 * JavaScript that the home page does not otherwise need (release 0.55.0 was a
 * bundle diet for exactly this page), and these texts only appear after a
 * click. So the renderer loads on demand; until it arrives the plain text
 * shows in the same type. tests/home-bundle.test.ts pins that no static
 * import from components/home.tsx reaches the renderer.
 *
 * Chat-route surfaces (the question bar, the probe card) already carry the
 * renderer and use ToolContentResponse directly.
 */

export type StatementType = "name" | "statement";

/** The two small types: the plain fallback and the rendered Markdown line up.
 *  `.lh-prose` sets the chat font and size in unlayered CSS that beats
 *  Tailwind's type utilities, so the rendered form overrides its variables. */
export const STATEMENT_TYPE: Record<StatementType, { plain: string; prose: string }> = {
	name: {
		plain: "text-sm font-medium leading-snug",
		prose: "font-medium [--lh-prose-size:var(--text-sm)] [--lh-prose-leading:1.375]",
	},
	statement: {
		plain: "text-xs leading-relaxed",
		prose: "[--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625]",
	},
};

const RenderedStatement = lazy(() => import("@/components/statement-text-rendered"));

export function StatementText({
	children,
	type = "statement",
	className,
}: {
	children: string;
	type?: StatementType;
	/** Layout and colour (margins, flex, text-muted-foreground). */
	className?: string;
}) {
	return (
		<Suspense
			fallback={<div className={cn(STATEMENT_TYPE[type].plain, "min-w-0 max-w-full whitespace-pre-line break-words", className)}>{children}</div>}
		>
			<RenderedStatement type={type} className={className}>
				{children}
			</RenderedStatement>
		</Suspense>
	);
}
