"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { CopyControlsContext } from "@/components/md-blocks";
import { STATEMENT_TYPE, type StatementType } from "@/components/statement-text";
import { cn } from "@/lib/utils";

/** The loaded half of StatementText (see there): one default export so it can
 *  be code-split. Static mode (never streamed), no corner copy icons, and a
 *  block that scrolls sideways inside itself when a formula or table is wider
 *  than its container: it never widens the pane around it, and nothing is
 *  clipped out of reach. Inline code inherits the line's size and colour.
 *
 *  Line spacing: a tall inline formula (a nested fraction) sets its own line
 *  height, from KaTeX's own boxes, so the leading variable does not help;
 *  measured at 390 px, stacked fractions on two consecutive lines met. A 2px
 *  margin on each formula box (`.katex-base`) separates them. Only lines that
 *  hold math are taller, so plain statements are unchanged. */
export default function RenderedStatement({
	children,
	type = "statement",
	className,
}: {
	children: string;
	type?: StatementType;
	className?: string;
}) {
	return (
		<CopyControlsContext.Provider value={false}>
			<ToolContentResponse
				mode="static"
				className={cn(
					"[--font-prose:var(--font-ui)] [&_[data-streamdown=inline-code]]:[font-size:inherit] [&_[data-streamdown=inline-code]]:[color:inherit] [&_.katex-base]:my-0.5",
					STATEMENT_TYPE[type].prose,
					"min-w-0 max-w-full overflow-x-auto",
					className,
				)}
			>
				{children}
			</ToolContentResponse>
		</CopyControlsContext.Provider>
	);
}
