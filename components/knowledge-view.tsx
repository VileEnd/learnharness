"use client";

import { useCallback, useEffect, useState } from "react";
import type { KnowledgeView as KnowledgeViewData } from "@/src/core";
import { KnowledgeEmpty, KnowledgeOverviewBody } from "@/components/knowledge-overview";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { TopBar } from "@/components/top-bar";
import { useKnowledgeView } from "@/components/use-knowledge-view";
import { cn } from "@/lib/utils";

/**
 * MY KNOWLEDGE (/knowledge): what the learner has shown, apart from the home
 * graph. A header switch picks Graph (the checked concepts only, coloured by
 * state) or Overview (due today, open confusions, per-topic progress). It
 * opens on Graph; the last choice is remembered per browser (localStorage,
 * best effort). A concept in the Overview opens the Graph focused on it.
 */

export type KnowledgeTab = "graph" | "overview";

export const KNOWLEDGE_TAB_KEY = "lh.knowledge.tab.v1";

/** A stored tab value, or the default (Graph) for anything else. */
export function parseKnowledgeTab(raw: string | null | undefined): KnowledgeTab {
	return raw === "overview" ? "overview" : "graph";
}

const TABS: ReadonlyArray<{ id: KnowledgeTab; label: string }> = [
	{ id: "graph", label: "Graph" },
	{ id: "overview", label: "Overview" },
];

export function KnowledgeTabSwitch({ tab, onTab }: { tab: KnowledgeTab; onTab: (t: KnowledgeTab) => void }) {
	return (
		<div role="tablist" aria-label="My knowledge" data-testid="knowledge-switch" className="flex shrink-0 rounded-lg border border-border/70 bg-card/80 p-0.5">
			{TABS.map((t) => (
				<button
					key={t.id}
					type="button"
					role="tab"
					aria-selected={tab === t.id}
					data-testid={`knowledge-tab-${t.id}`}
					onClick={() => onTab(t.id)}
					className={cn(
						"h-8 rounded-md px-3 text-xs transition-colors pointer-coarse:h-9",
						tab === t.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{t.label}
				</button>
			))}
		</div>
	);
}

/** The page body for a loaded payload (the tab content under the header). Pure of its props. */
export function KnowledgeBody({
	view,
	tab,
	focusId,
	onFocusDone,
	onOpenConcept,
}: {
	view: KnowledgeViewData;
	tab: KnowledgeTab;
	focusId: string | null;
	onFocusDone: () => void;
	onOpenConcept: (id: string) => void;
}) {
	if (view.overview.checkedCount === 0) return <KnowledgeEmpty />;
	if (tab === "overview") {
		return (
			<div className="h-full overflow-y-auto pb-safe">
				<KnowledgeOverviewBody overview={view.overview} onOpenConcept={onOpenConcept} />
			</div>
		);
	}
	return <KnowledgeGraph view={view} focusId={focusId} onFocusDone={onFocusDone} />;
}

export function KnowledgeView() {
	const { view, failed } = useKnowledgeView();
	// null until the stored choice is read, so the wrong tab never flashes.
	const [tab, setTab] = useState<KnowledgeTab | null>(null);
	const [focusId, setFocusId] = useState<string | null>(null);
	useEffect(() => {
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(KNOWLEDGE_TAB_KEY);
		} catch {
			// storage blocked: the default stands
		}
		setTab(parseKnowledgeTab(stored));
	}, []);
	const choose = useCallback((next: KnowledgeTab) => {
		setTab(next);
		try {
			localStorage.setItem(KNOWLEDGE_TAB_KEY, next);
		} catch {
			// best effort
		}
	}, []);
	const openConcept = useCallback(
		(id: string) => {
			setFocusId(id);
			choose("graph");
		},
		[choose],
	);
	const clearFocus = useCallback(() => setFocusId(null), []);
	const checked = view?.overview.checkedCount ?? 0;
	return (
		<div data-testid="knowledge-view" className="flex h-full min-h-0 flex-col">
			<TopBar>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{view && checked > 0 ? `${checked} ${checked === 1 ? "concept" : "concepts"} checked` : ""}
				</span>
				{tab && <KnowledgeTabSwitch tab={tab} onTab={choose} />}
			</TopBar>
			<div className="relative min-h-0 flex-1">
				{tab && view ? (
					<KnowledgeBody view={view} tab={tab} focusId={focusId} onFocusDone={clearFocus} onOpenConcept={openConcept} />
				) : failed ? (
					<p className="px-6 pt-10 text-center text-sm text-muted-foreground">Could not load your knowledge. Try again in a moment.</p>
				) : null}
			</div>
		</div>
	);
}
