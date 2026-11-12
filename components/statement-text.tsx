"use client";

import { useEffect, useState, type ComponentType } from "react";
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
 * click. So the renderer loads on demand (and is preloaded when the page is
 * idle); until it arrives the plain text shows in the same type.
 * tests/home-bundle.test.ts pins that no static import from components/home.tsx
 * reaches the renderer.
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

interface StatementProps {
	children: string;
	type?: StatementType;
	/** Layout and colour (margins, flex, text-muted-foreground). */
	className?: string;
}
type Renderer = ComponentType<StatementProps>;

/** Text that is surely not Markdown or math can show as it is while the
 *  renderer loads; anything else would flash its raw source (`$x^2$`, backticks)
 *  and then jump to a different height when rendered. */
const MAY_BE_MARKUP = /[$\\`*_[\]<>|#~]|(?:^|\n)\s*(?:[-+]\s|\d+[.)]\s)/;

/** The statement as plain text in the surface's type. Final when the renderer
 *  cannot load; while it is loading (`pending`), text that may hold markup is
 *  hidden (its space reserved, nothing for a screen reader to misread). */
function PlainStatement({ children, type = "statement", className, pending }: StatementProps & { pending?: boolean }) {
	return (
		<div
			className={cn(
				STATEMENT_TYPE[type].plain,
				"min-w-0 max-w-full whitespace-pre-line break-words",
				pending && MAY_BE_MARKUP.test(children) && "invisible",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** The seam: StatementText over an injectable import of the renderer (tests
 *  pass a failing one). The import is shared and, once it has succeeded, the
 *  component is remembered, so a card or row opened after that renders the
 *  Markdown on its first commit.
 *
 *  Not React.lazy / Suspense, on purpose: (1) React throttles revealing a
 *  suspended boundary's content for 300 ms after its fallback showed, so even
 *  an already-loaded chunk made every first open wait ~300 ms (measured in
 *  Chromium); a state update has no such throttle. (2) A failed load (after a
 *  deploy an open tab asks for a chunk that is gone, or the network drops)
 *  must leave the plain text, never an error: lazy rethrows the rejection
 *  during render and Suspense does not catch it, so the page's error screen
 *  replaced the whole home page. A failed load is not cached; the next mount
 *  asks again. */
export function createStatementText(importRenderer: () => Promise<{ default: Renderer }>) {
	let loaded: Renderer | null = null;
	let loading: Promise<Renderer> | null = null;
	const load = () =>
		(loading ??= importRenderer().then(
			(module) => (loaded = module.default),
			(error: unknown) => {
				loading = null;
				throw error;
			},
		));

	function StatementText({ children, type = "statement", className }: StatementProps) {
		const [Rendered, setRendered] = useState<Renderer | null>(() => loaded);
		const [failed, setFailed] = useState(false);
		useEffect(() => {
			if (Rendered) return;
			let live = true;
			load().then(
				(component) => live && setRendered(() => component),
				() => live && setFailed(true),
			);
			return () => {
				live = false;
			};
		}, [Rendered]);
		if (Rendered) return <Rendered type={type} className={className}>{children}</Rendered>;
		return <PlainStatement type={type} className={className} pending={!failed}>{children}</PlainStatement>;
	}
	return { StatementText, preload: () => void load().catch(() => undefined) };
}

const shared = createStatementText(() => import("@/components/statement-text-rendered"));
export const StatementText = shared.StatementText;
/** Start loading the renderer now (the chunk is about 0.7 MB and costs ~300 ms
 *  of script evaluation on a phone-class profile; see the preload below). */
export const preloadStatementRenderer = shared.preload;

// Preload once the page is idle after its first paint, so the first card or
// row a learner opens does not wait for it. The dynamic import keeps the chunk
// out of the first-load bundle (tests/home-bundle.test.ts). No window, no
// preload (tests, the server render).
if (typeof window !== "undefined") {
	const whenIdle = () => {
		if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(preloadStatementRenderer, { timeout: 4000 });
		else window.setTimeout(preloadStatementRenderer, 2000);
	};
	if (document.readyState === "complete") whenIdle();
	else window.addEventListener("load", whenIdle, { once: true });
}
