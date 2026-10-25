"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
	DEFAULT_RENDER_SETTINGS,
	incrementalLayout,
	LEARNER_DUE_RING,
	LEARNER_STATE_STYLES,
	learnerNodeStyle,
	sanitizeRenderSettings,
	type KnowledgeView,
} from "@/src/core";
import { tokenHex } from "@/components/css-color";
import { NodeCardBody, useCardPlacement } from "@/components/graph-node-card";
import { LearnerLegend } from "@/components/learner-legend";
import { GraphCanvasRenderer, type GraphRenderSettings } from "./graph-canvas.ts";

/**
 * The "My knowledge" Graph tab: only the concepts that have evidence, filled by
 * state (the overlay's colours, a ring when due), with the edges of the chains
 * among them. It reuses the home graph's canvas renderer and card, but owns its
 * layout: the same seeded d3-force pass the home graph falls back to, run once
 * on this subset and frozen (deterministic; nothing is read from or written to
 * the stored positions - the renderer's drag commits go nowhere). Render sizes
 * are the home graph's saved settings, read only.
 */

/** The fit keeps clear of the legend overlaid at the top-left. */
const FIT_INSET_TOP = 44;
/** Up to this many concepts, every name is always shown. */
export const ALWAYS_LABELS_MAX_NODES = 80;
const LABEL_MAX_CHARS = 28;

/** A concept name for the canvas: long names are cut with an ellipsis (the card has the full one). */
export function shortLabel(name: string): string {
	return name.length > LABEL_MAX_CHARS ? `${name.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}\u2026` : name;
}

/** Which names are always on: all of them for a small subset, else only the solid, shaky and due
 *  concepts (the rest follow the zoom gate). Implication nodes never label. */
export function alwaysLabelIds(
	ids: readonly string[],
	states: Readonly<Record<string, { state: string; due: boolean }>>,
): ReadonlySet<string> | "all" {
	const concepts = ids.filter((id) => !id.startsWith("arg_"));
	if (concepts.length <= ALWAYS_LABELS_MAX_NODES) return "all";
	return new Set(concepts.filter((id) => states[id]?.state === "solid" || states[id]?.state === "shaky" || states[id]?.due === true));
}

interface Open {
	id: string;
	anchor: { x: number; y: number };
}

export function KnowledgeGraph({
	view,
	focusId,
	onFocusDone,
}: {
	view: KnowledgeView;
	/** A concept to centre and open (deep link from the Overview). */
	focusId: string | null;
	onFocusDone: () => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const rendererRef = useRef<GraphCanvasRenderer | null>(null);
	const [open, setOpen] = useState<Open | null>(null);
	const placement = useMemo(
		() => (open ? { node: view.graph.nodes.find((n) => n.id === open.id) ?? view.graph.nodes[0]!, sourceIds: [], anchor: open.anchor } : null),
		[open, view.graph.nodes],
	);
	const cardRef = useCardPlacement(placement, containerRef);
	const [settings, setSettings] = useState<GraphRenderSettings>(DEFAULT_RENDER_SETTINGS);
	const viewRef = useRef(view);
	viewRef.current = view;

	// The home graph's saved render settings (sizes, label zoom): read once, never written.
	useEffect(() => {
		let cancelled = false;
		fetch("/api/graph/render-settings")
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
			.then((raw) => {
				if (!cancelled && raw !== null) setSettings(sanitizeRenderSettings(raw));
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	// Layout: one seeded pass per structure (ids + edges), so a refetch that changed
	// only states keeps every node where it was.
	const nodes = view.graph.nodes;
	const edges = view.graph.edges;
	const structureKey = useMemo(
		() => `${nodes.map((n) => n.id).join("|")}#${edges.map((e) => `${e.from}>${e.to}`).join("|")}`,
		[nodes, edges],
	);
	const positions = useMemo(
		() => incrementalLayout(nodes, edges, new Map()),
		[structureKey],
	);

	const hasNodes = nodes.length > 0;
	useEffect(() => {
		if (!hasNodes) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const renderer = new GraphCanvasRenderer(
			canvas,
			{
				onSelect: (nodeId, pos) => {
					if (viewRef.current.graph.nodes.some((n) => n.id === nodeId)) setOpen({ id: nodeId, anchor: pos });
				},
				onStageClick: () => setOpen(null),
				onContext: () => {},
				onCameraMove: () => setOpen(null),
				// Dragging a node settles the live sim, but this layout is never persisted.
				onCommit: () => {},
			},
			null,
		);
		// This view has no composer dock: only the legend sits over the canvas (the header and
		// the phone tab bar are outside it), so the fit keeps clear of the legend alone.
		renderer.setFitInsets({ top: FIT_INSET_TOP, bottom: 0 });
		rendererRef.current = renderer;
		return () => {
			rendererRef.current = null;
			renderer.destroy();
		};
	}, [hasNodes]);

	// Feed 1: data. Feed 2: state colours. Feed 3: settings. Feed 4: selection glow.
	useEffect(() => {
		const renderer = rendererRef.current;
		if (!renderer || !hasNodes) return;
		renderer.setData({
			nodes: nodes.map((n) => ({ id: n.id, x: positions.get(n.id)?.x ?? 0, y: positions.get(n.id)?.y ?? 0, label: shortLabel(n.name) })),
			edges: edges.map((e) => ({ from: e.from, to: e.to })),
			logicalEdges: view.graph.logicalEdges.map((e) => ({ from: e.from, to: e.to })),
			impLinks: view.graph.impLinks,
			clusters: [],
			colors: {
				node: tokenHex("--primary"),
				edge: tokenHex("--ring"),
				label: tokenHex("--muted-foreground"),
				hoverText: tokenHex("--foreground"),
			},
			fontFamily: getComputedStyle(document.body).fontFamily,
		});
		const byNode = new Map<string, { color: string; due: boolean }>();
		for (const [id, st] of Object.entries(view.learner.states)) byNode.set(id, learnerNodeStyle(st));
		renderer.setAlwaysLabels(
			alwaysLabelIds(
				nodes.map((n) => n.id),
				view.learner.states,
			),
		);
		renderer.setKnowledge({
			byNode,
			fallback: LEARNER_STATE_STYLES["not-yet-checked"].color,
			ringColor: LEARNER_DUE_RING.color,
		});
	}, [view, nodes, edges, positions, hasNodes]);

	const deferredSettings = useDeferredValue(settings);
	useEffect(() => {
		rendererRef.current?.setSettings(deferredSettings);
		rendererRef.current?.setRegionTuning(deferredSettings.regions);
		rendererRef.current?.setPhysicsTuning(deferredSettings.physics);
	}, [deferredSettings, hasNodes]);

	const openNode = open ? nodes.find((n) => n.id === open.id) : undefined;
	useEffect(() => {
		rendererRef.current?.setSelected(openNode?.id ?? null);
	}, [openNode, hasNodes]);

	// Deep link: centre the camera on the concept and open its card. The canvas may
	// not have a size on the first frame, so retry for a moment.
	useEffect(() => {
		if (!focusId || !hasNodes) return;
		let raf = 0;
		let tries = 0;
		const attempt = () => {
			const pos = rendererRef.current?.focusNode(focusId) ?? null;
			if (pos) {
				setOpen({ id: focusId, anchor: pos }); // after the camera move, which closes any card
				onFocusDone();
			} else if (tries++ < 60) {
				raf = requestAnimationFrame(attempt);
			} else {
				onFocusDone();
			}
		};
		raf = requestAnimationFrame(attempt);
		return () => cancelAnimationFrame(raf);
	}, [focusId, hasNodes, onFocusDone]);

	const state = openNode ? view.learner.states[openNode.id] : undefined;
	return (
		<div ref={containerRef} data-testid="knowledge-graph" className="relative h-full w-full">
			<LearnerLegend className="absolute left-2 top-2 z-10 max-w-[calc(100%-1rem)]" />
			<canvas ref={canvasRef} className="block h-full w-full touch-none" />
			{open && openNode && (
				<div
					ref={cardRef}
					data-testid="knowledge-card"
					// Positioned imperatively (useCardPlacement); hidden until placed.
					style={{ visibility: "hidden", left: 0, top: 0 }}
					className="absolute z-10 max-h-[min(60dvh,28rem)] w-80 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border bg-card p-4 text-left shadow-lg"
				>
					<NodeCardBody
						node={openNode}
						sourceIds={view.graph.nodeSessions[openNode.id] ?? []}
						sessions={view.graph.sessions}
						fileSources={view.graph.fileSources}
						documents={view.graph.documents}
						knowledge={{ state, sessions: { ...view.graph.sessions, ...view.learner.sessions } }}
					/>
				</div>
			)}
		</div>
	);
}
