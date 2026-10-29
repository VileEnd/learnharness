"use client";

/**
 * THE CANVAS WORKSPACE (PR 2): a session-area overlay for an agent-posed canvas task (work / sketch) or a
 * practice problem with `canvas: true`. Mounted like MermaidOverlay (a sibling of the scroller inside the
 * session area, never fixed inset-0, so the top bar and sidebar stay), it claims Esc at the document level
 * (one Esc minimises) and the back gesture, and its "Your thinking" field claims dictation while open.
 *
 * The working scene autosaves to the server draft (PUT drafts/<callId>, 2 s debounce, revisioned) and is
 * mirrored to localStorage on every change; on open the newer of the two wins (draft.ts pickDraft), so going
 * offline mid-task loses nothing. Submit exports the PNG, POSTs it to /drawings and hands the returned
 * drawingId to onSubmit; an empty scene submits text only. Hint sends the same snapshot (and the "Your
 * thinking" draft, kept in the field) with the request and stays open, so the tutor's marks land in view.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	ArrowUpRightIcon, CircleIcon, EraserIcon, EyeIcon, EyeOffIcon, FileTextIcon, HandIcon, HighlighterIcon, ImageIcon, LightbulbIcon, MinusIcon, Minimize2Icon,
	MousePointer2Icon, PencilIcon, PenLineIcon, Redo2Icon, ScanIcon, SigmaIcon, SquareIcon, TableIcon, TypeIcon, Undo2Icon,
} from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { enterSends, useEnterSubmits } from "@/components/enter-submits";
import { useAutoGrow, useCoarsePointer } from "@/components/use-coarse-pointer";
import { useBackDismiss } from "@/components/use-back-dismiss";
import type { Viewport } from "@/components/pan-zoom";
import { cn } from "@/lib/utils";
import { hintsFor, isInputBoundary, latestTaskMarks, nextObjectId, sceneBoundingBox, type AnnotationMark, type BlockObject, type Box, type DrawingScene, type TableObject, type ImageObject } from "@/src/core";
import { CanvasEngine, type CanvasTool } from "./canvas-engine";
import { fitImageSize, PALETTE_NAMES, revealView, screenColor } from "./geometry";
import { CanvasObjectsLayer, uploadAsset } from "./canvas-objects";
import { TeacherInk, teacherInkBoxes } from "./teacher-ink";
import { useDrawingScene } from "./use-drawing-scene";
import { HintStrip, HintsButton } from "./hints";
import { pickDraft, readLocalDraft, writeLocalDraft } from "./draft";

export const AUTOSAVE_MS = 2000;
export const EMPTY_SCENE: DrawingScene = { version: 1, objects: [] };
const SIZES = [2, 4, 8] as const;

const TOOLS: Array<{ tool: CanvasTool; label: string; Icon: typeof PenLineIcon }> = [
	{ tool: "select", label: "Select", Icon: MousePointer2Icon },
	{ tool: "pan", label: "Pan", Icon: HandIcon },
	{ tool: "pen", label: "Pen", Icon: PenLineIcon },
	{ tool: "pencil", label: "Pencil", Icon: PencilIcon },
	{ tool: "marker", label: "Marker", Icon: HighlighterIcon },
	{ tool: "line", label: "Line", Icon: MinusIcon },
	{ tool: "arrow", label: "Arrow", Icon: ArrowUpRightIcon },
	{ tool: "rect", label: "Rectangle", Icon: SquareIcon },
	{ tool: "ellipse", label: "Ellipse", Icon: CircleIcon },
	{ tool: "eraser", label: "Eraser", Icon: EraserIcon },
	{ tool: "text", label: "Text", Icon: TypeIcon },
	{ tool: "markdown", label: "Markdown", Icon: FileTextIcon },
	{ tool: "latex", label: "LaTeX", Icon: SigmaIcon },
	{ tool: "table", label: "Table", Icon: TableIcon },
	{ tool: "image", label: "Image", Icon: ImageIcon },
];
const PLACE_TOOLS: readonly CanvasTool[] = ["text", "markdown", "latex", "table", "image"];

export interface CanvasWorkspaceProps {
	chatId: string;
	/** The task's tool-call id (work/sketch call, or the practice problem's). */
	callId: string;
	question: string;
	details?: string;
	/** Submit stays disabled until "Your thinking" has text (the agent's requireThinking). */
	requireThinking?: boolean;
	/** text + the uploaded drawing's id (absent for an empty scene). */
	onSubmit: (text: string, drawingId?: string) => void;
	/** The Hint button: the host sends { type: "hint", callId, drawingId?, text? } - a snapshot of the canvas
	 *  (absent for an empty scene) and the trimmed "Your thinking" draft (absent when empty). */
	onHint?: (drawingId?: string, text?: string) => void;
	onMinimize: () => void;
	/** Compaction running: submit would block on the server's gate. */
	compactionRunning?: boolean;
	/** The session record: the teacher's marks on this task's submitted drawings are derived from it (annotationsOf). */
	messages?: readonly unknown[];
	/** A turn is running: a hint request without a reply yet is then "pending" (Getting a hint…), else it is just empty. */
	turnBusy?: boolean;
}

/** Pure: may Submit fire? Something to send, and the required thinking present. */
export function canSubmitWork(s: { text: string; objectCount: number; requireThinking: boolean; busy: boolean }): boolean {
	if (s.busy) return false;
	const text = s.text.trim();
	if (s.requireThinking && text.length === 0) return false;
	return text.length > 0 || s.objectCount > 0;
}

/** Pure: may the canvas Hint fire? The draft is loaded (else the snapshot would miss his work), nothing is
 *  uploading, and no turn runs (a hint sent then would be dropped). */
export function canRequestHint(s: { loaded: boolean; compactionRunning: boolean; busy: boolean; turnBusy: boolean }): boolean {
	return s.loaded && !s.compactionRunning && !s.busy && !s.turnBusy;
}

function nextZ(scene: DrawingScene): number {
	let z = 0;
	for (const o of scene.objects) if (o.z >= z) z = o.z + 1;
	return z;
}

export function CanvasWorkspace({ chatId, callId, question, details, requireThinking = false, onSubmit, onHint, onMinimize, compactionRunning = false, messages = [], turnBusy = false }: CanvasWorkspaceProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const engineRef = useRef<CanvasEngine | null>(null);
	const [scene, setScene] = useState<DrawingScene>(EMPTY_SCENE);
	const sceneRef = useRef<DrawingScene>(EMPTY_SCENE);
	const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
	const [tool, setToolState] = useState<CanvasTool>("pen");
	const [color, setColor] = useState<string>("ink");
	const [size, setSize] = useState<number>(4);
	const [selected, setSelected] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [showInk, setShowInk] = useState(true);
	// The marks of the newest marking turn on this task's drawings (a submission or a hint snapshot); null until
	// the teacher annotates.
	const inkDrawing = useMemo(() => latestTaskMarks(messages, callId), [messages, callId]);
	const inkKey = useMemo(() => (inkDrawing ? `${inkDrawing.drawingId}:${JSON.stringify(inkDrawing.marks)}` : ""), [inkDrawing]);
	// The replies to this task's hint requests, derived from the record (so they survive minimise and reload).
	const hints = useMemo(() => hintsFor(messages, callId), [messages, callId]);
	// Pending only while that request is still the newest input (isInputBoundary, the same rule hintsFor ends a
	// hint's window on): a later submission, message, answer or job steer means the running turn is not "getting
	// a hint".
	const newestRequestIsLatestInput = useMemo(() => {
		const id = hints[hints.length - 1]?.requestId;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (isInputBoundary(m)) return (m as { id?: string }).id === id;
		}
		return false;
	}, [messages, hints]);
	// The whole hint turn, not just until its first token: a second tap mid-stream would spend another rung.
	const hintTurnBusy = turnBusy && newestRequestIsLatestInput;
	const [hintsOpen, setHintsOpen] = useState(false);
	const hintsOpenRef = useRef(false);
	hintsOpenRef.current = hintsOpen;
	const [loaded, setLoaded] = useState(false);
	const [thinking, setThinking] = useState("");
	const thinkingRef = useRef("");
	const revRef = useRef(0);
	const dirtyRef = useRef(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savingRef = useRef(false);
	const pendingImageAt = useRef<{ x: number; y: number } | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const coarse = useCoarsePointer();
	useAutoGrow(fieldRef, thinking);

	// ── the back gesture and Esc: one Esc, one action (minimise) ──
	useBackDismiss(true, onMinimize);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			// One Esc, one action: an open hints panel closes first.
			if (hintsOpenRef.current) setHintsOpen(false);
			else onMinimize();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onMinimize]);

	// ── dictation feeds "Your thinking" while the workspace is open ──
	useDictationTarget(
		useCallback((t: string) => {
			const v = joinDictation(thinkingRef.current, t);
			thinkingRef.current = v;
			setThinking(v);
		}, []),
		true,
	);

	// ── draft save (server, revisioned) ──
	const saveNow = useCallback(async () => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = null;
		if (!dirtyRef.current || savingRef.current) return;
		savingRef.current = true;
		const snapshot = sceneRef.current;
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/drawings/drafts/${encodeURIComponent(callId)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ scene: snapshot, baseRev: revRef.current }),
			});
			if (res.ok) {
				const { rev } = (await res.json()) as { rev: number };
				revRef.current = rev;
				if (sceneRef.current === snapshot) {
					dirtyRef.current = false;
					writeLocalDraft(chatId, callId, { scene: snapshot, rev, dirty: false });
				} else {
					writeLocalDraft(chatId, callId, { scene: sceneRef.current, rev, dirty: true });
				}
			} else if (res.status === 409) {
				// Another device saved first: its draft wins; say so.
				const cur = (await res.json().catch(() => null)) as { scene?: DrawingScene; rev?: number } | null;
				if (cur?.scene && typeof cur.rev === "number") {
					revRef.current = cur.rev;
					dirtyRef.current = false;
					sceneRef.current = cur.scene;
					engineRef.current?.setScene(cur.scene);
					setScene(cur.scene);
					writeLocalDraft(chatId, callId, { scene: cur.scene, rev: cur.rev, dirty: false });
					setNotice("Updated from your other device");
				}
			}
			// Other failures (offline, 5xx): stay dirty; the local mirror holds the scene.
		} catch {
			/* offline: the next change retries */
		} finally {
			savingRef.current = false;
		}
	}, [chatId, callId]);
	const saveNowRef = useRef(saveNow);
	saveNowRef.current = saveNow;

	const onSceneChange = useCallback(
		(next: DrawingScene) => {
			sceneRef.current = next;
			setScene(next);
			dirtyRef.current = true;
			writeLocalDraft(chatId, callId, { scene: next, rev: revRef.current, dirty: true });
			if (saveTimer.current) clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => void saveNowRef.current(), AUTOSAVE_MS);
		},
		[chatId, callId],
	);

	// ── mount: engine + draft load ──
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const engine = new CanvasEngine(root, {
			theme: readTheme,
			onChange: onSceneChange,
			onSelect: setSelected,
			onViewChange: setView,
			onPlace: (t, at) => placeObject(t, at),
		});
		engineRef.current = engine;
		let cancelled = false;
		(async () => {
			let server: { scene: DrawingScene; rev: number } | null = null;
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/drawings/drafts/${encodeURIComponent(callId)}`);
				if (res.ok) server = (await res.json()) as { scene: DrawingScene; rev: number };
			} catch {
				/* offline: the local mirror carries the scene */
			}
			if (cancelled) return;
			const picked = pickDraft(server, readLocalDraft(chatId, callId));
			if (picked) {
				revRef.current = picked.rev;
				sceneRef.current = picked.scene;
				engine.setScene(picked.scene);
				setScene(picked.scene);
				// Local edits the server never saw go up on the next tick.
				if (picked.from === "local") {
					dirtyRef.current = true;
					saveTimer.current = setTimeout(() => void saveNowRef.current(), AUTOSAVE_MS);
				}
			}
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
			// Minimising/closing flushes the draft right away.
			void saveNowRef.current();
			engine.destroy();
			engineRef.current = null;
		};
		// mount-scoped by design: chatId/callId are fixed for a workspace instance
	}, []);

	useEffect(() => {
		engineRef.current?.setTool(tool);
	}, [tool]);
	useEffect(() => {
		engineRef.current?.setBrush({ color, size });
	}, [color, size]);

	const setTool = (t: CanvasTool) => {
		setToolState(t);
		if (t !== "select") setSelected(null);
	};

	// ── typed-object placement and image upload ──
	const commit = useCallback((next: DrawingScene) => engineRef.current?.applyScene(next), []);
	const addImage = useCallback(
		async (file: Blob, at: { x: number; y: number }) => {
			try {
				const { blob, w: nw, h: nh } = await downscaleImage(file);
				const assetId = await uploadAsset(chatId, blob);
				const dims = { w: nw, h: nh };
				const w = Math.min(dims.w, 400);
				const h = Math.round((w / dims.w) * dims.h * 10) / 10;
				const cur = sceneRef.current;
				const obj: ImageObject = { id: nextObjectId(cur), z: nextZ(cur), type: "image", x: at.x, y: at.y, w, h, assetId };
				commit({ ...cur, objects: [...cur.objects, obj] });
			} catch (e) {
				setError(e instanceof Error ? e.message : "Image upload failed");
			}
		},
		[chatId, commit],
	);
	const placeObject = (t: CanvasTool, at: { x: number; y: number }) => {
		const cur = sceneRef.current;
		if (t === "image") {
			pendingImageAt.current = at;
			fileRef.current?.click();
			return;
		}
		const base = { id: nextObjectId(cur), z: nextZ(cur), x: at.x, y: at.y };
		let obj: BlockObject | TableObject;
		if (t === "table") obj = { ...base, type: "table", w: 300, h: 130, cells: [["", ""], ["", ""]] };
		else if (t === "text" || t === "markdown" || t === "latex") obj = { ...base, type: t, w: 240, h: 110, source: "" };
		else return;
		commit({ ...cur, objects: [...cur.objects, obj] });
		setToolState("select");
		setSelected(obj.id);
	};
	// Paste an image from the clipboard at the view centre.
	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
			if (!file) return;
			e.preventDefault();
			const r = rootRef.current?.getBoundingClientRect();
			const v = engineRef.current?.getView() ?? { zoom: 1, x: 0, y: 0 };
			void addImage(file, { x: ((r?.width ?? 400) / 2 - v.x) / v.zoom, y: ((r?.height ?? 300) / 2 - v.y) / v.zoom });
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
	}, [addImage]);

	// ── submit and hint ──
	const objectCount = scene.objects.length;
	const canSubmit = loaded && !compactionRunning && canSubmitWork({ text: thinking, objectCount, requireThinking, busy });
	// The canvas as it is now: PNG + scene POSTed to /drawings; undefined for an empty scene (nothing is sent).
	const uploadSnapshot = async (): Promise<string | undefined> => {
		const engine = engineRef.current;
		const current = engine?.getScene() ?? sceneRef.current;
		if (!engine || current.objects.length === 0) return undefined;
		const png = await engine.exportPng();
		const form = new FormData();
		form.set("scene", JSON.stringify(current));
		form.set("png", png, "drawing.png");
		const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/drawings`, { method: "POST", body: form });
		if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The drawing upload failed (${res.status}).`);
		return ((await res.json()) as { drawingId: string }).drawingId;
	};
	const submit = async () => {
		if (!canSubmit) return;
		setBusy(true);
		setError(null);
		try {
			const text = thinkingRef.current.trim();
			const drawingId = await uploadSnapshot();
			await saveNowRef.current();
			thinkingRef.current = "";
			setThinking("");
			onSubmit(text, drawingId);
			onMinimize();
		} catch (e) {
			setError(e instanceof Error ? e.message : "The submit failed.");
		} finally {
			setBusy(false);
		}
	};
	// New marks out of view (a note below the visible part of his drawing): move the view once per set of marks
	// while the canvas is open, so panning away afterwards is his to do. A reopened canvas starts from the default
	// view, so it shows them again.
	const revealedRef = useRef<string | null>(null);
	const revealMarks = useCallback((key: string, boxes: Box[]) => {
		const engine = engineRef.current;
		const root = rootRef.current;
		if (!engine || !root || revealedRef.current === key) return;
		revealedRef.current = key;
		const r = root.getBoundingClientRect();
		const next = revealView({ w: r.width, h: r.height }, engine.getView(), boxes);
		if (next) engine.setView(next);
	}, []);

	// The hint carries the snapshot and the draft (which stays in the field); the canvas stays open so the
	// tutor's marks appear where he is working.
	const hint = async () => {
		if (!onHint) return;
		setBusy(true);
		setError(null);
		try {
			const text = thinkingRef.current.trim();
			const drawingId = await uploadSnapshot();
			onHint(drawingId, text.length > 0 ? text : undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : "The hint request failed.");
		} finally {
			setBusy(false);
		}
	};
	useEnterSubmits(() => void submit());

	const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "light" as const);
	useEffect(() => engineRef.current?.refresh(), [theme]);
	const interactive = tool === "select" || PLACE_TOOLS.includes(tool);
	const zoomPct = useMemo(() => Math.round(view.zoom * 100), [view.zoom]);

	return (
		<div
			data-testid="canvas-workspace"
			role="dialog"
			aria-modal="true"
			aria-label="Canvas"
			className="absolute inset-0 z-40 flex flex-col bg-background/95 p-3 backdrop-blur-sm"
		>
			{/* The question strip */}
			<div data-testid="canvas-question" className="mb-2 max-h-28 shrink-0 overflow-y-auto rounded-lg border bg-card px-3 py-2">
				<div className="lh-prose text-sm">
					<ToolContentResponse>{question}</ToolContentResponse>
					{details ? <ToolContentResponse>{details}</ToolContentResponse> : null}
				</div>
			</div>

			{/* The toolbar */}
			<div data-testid="canvas-toolbar" className="mb-2 flex shrink-0 flex-wrap items-center gap-1 rounded-lg border bg-card p-1">
				{TOOLS.map(({ tool: t, label, Icon }) => (
					<button key={t} type="button" title={label} aria-label={label} aria-pressed={tool === t} data-testid={`canvas-tool-${t}`} onClick={() => setTool(t)} className={cn("rounded-md p-1.5 pointer-coarse:p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", tool === t && "bg-accent text-foreground")}>
						<Icon className="size-4" />
					</button>
				))}
				<span className="mx-1 h-5 w-px bg-border" />
				<button type="button" title="Undo" aria-label="Undo" data-testid="canvas-undo" onClick={() => engineRef.current?.undo()} className="rounded-md p-1.5 pointer-coarse:p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">
					<Undo2Icon className="size-4" />
				</button>
				<button type="button" title="Redo" aria-label="Redo" data-testid="canvas-redo" onClick={() => engineRef.current?.redo()} className="rounded-md p-1.5 pointer-coarse:p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">
					<Redo2Icon className="size-4" />
				</button>
				<span className="mx-1 h-5 w-px bg-border" />
				<div className="flex items-center gap-0.5" role="group" aria-label="Colour">
					{PALETTE_NAMES.map((c) => (
						<button key={c} type="button" title={c} aria-label={`Colour ${c}`} aria-pressed={color === c} data-testid={`canvas-color-${c}`} onClick={() => setColor(c)} className={cn("size-5 rounded-full border pointer-coarse:size-7", color === c ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "")} style={{ background: screenColor(c, theme) }} />
					))}
				</div>
				<span className="mx-1 h-5 w-px bg-border" />
				<div className="flex items-center gap-0.5" role="group" aria-label="Size">
					{SIZES.map((s) => (
						<button key={s} type="button" aria-label={`Size ${s}`} aria-pressed={size === s} data-testid={`canvas-size-${s}`} onClick={() => setSize(s)} className={cn("flex size-6 items-center justify-center rounded-md pointer-coarse:size-9 hover:bg-accent", size === s && "bg-accent")}>
							<span className="rounded-full bg-foreground" style={{ width: s + 2, height: s + 2 }} />
						</button>
					))}
				</div>
				<span className="mx-1 h-5 w-px bg-border" />
				<button type="button" title="Reset zoom" aria-label="Reset zoom" data-testid="canvas-zoom-reset" onClick={() => engineRef.current?.setView({ zoom: 1, x: 0, y: 0 })} className="flex items-center gap-1 rounded-md px-1.5 py-1 pointer-coarse:py-2.5 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground">
					<ScanIcon className="size-4" /> {zoomPct}%
				</button>
				{inkDrawing && (
					<button type="button" title="Teacher marks" aria-label="Teacher marks" aria-pressed={showInk} data-testid="canvas-ink-toggle" onClick={() => setShowInk((v) => !v)} className={cn("flex items-center gap-1 rounded-md px-1.5 py-1 pointer-coarse:py-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground", showInk && "bg-accent text-foreground")}>
						{showInk ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />} Teacher marks
					</button>
				)}
				<span className="ml-auto" />
				<HintsButton hints={hints} open={hintsOpen} onToggle={() => setHintsOpen((v) => !v)} />
				<button type="button" title="Minimise (Esc)" aria-label="Minimise" data-testid="canvas-minimize" onClick={onMinimize} className="rounded-md p-1.5 pointer-coarse:p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">
					<Minimize2Icon className="size-4" />
				</button>
			</div>

			{/* The surface */}
			<div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
				<div ref={rootRef} data-testid="canvas-surface" className="absolute inset-0" />
				<CanvasObjectsLayer chatId={chatId} scene={scene} view={view} interactive={interactive} selectedId={selected} onSelect={setSelected} onCommit={commit} />
				{showInk && inkDrawing && (
					<svg data-testid="canvas-ink" className="pointer-events-none absolute inset-0 size-full overflow-hidden" aria-hidden>
						<g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
							<WorkspaceInk key={inkDrawing.drawingId} chatId={chatId} drawingId={inkDrawing.drawingId} marks={inkDrawing.marks} marksKey={inkKey} live={scene} theme={theme} onReveal={revealMarks} />
						</g>
					</svg>
				)}
				{notice && (
					<div role="status" data-testid="canvas-notice" className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full border bg-popover px-3 py-1 text-xs shadow">
						{notice}
						<button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="ml-2 text-muted-foreground hover:text-foreground">
							×
						</button>
					</div>
				)}
				<input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden data-testid="canvas-image-input" onChange={(e) => {
					const f = e.target.files?.[0];
					e.target.value = "";
					if (f && pendingImageAt.current) void addImage(f, pendingImageAt.current);
					pendingImageAt.current = null;
				}} />
			</div>

			{/* The newest hint, above the thinking box (capped, collapsible) */}
			<HintStrip hints={hints} turnBusy={hintTurnBusy} />

			{/* The bottom bar: Your thinking + Hint + Submit */}
			<div data-testid="canvas-bottom" className="mt-2 shrink-0 rounded-[10px] border border-border/70 bg-card transition-colors focus-within:border-primary/50">
				<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Your thinking{requireThinking ? " (required)" : ""}
				</div>
				<textarea
					ref={fieldRef}
					data-testid="canvas-thinking"
					value={thinking}
					onChange={(e) => {
						thinkingRef.current = e.target.value;
						setThinking(e.target.value);
					}}
					onKeyDown={(e) => {
						if (enterSends(e, coarse)) {
							e.preventDefault();
							void submit();
						}
					}}
					placeholder="Work on the canvas, think out loud."
					enterKeyHint={coarse ? "enter" : "send"}
					rows={2}
					className="field-sizing-content lh-input max-h-40 min-h-12 w-full resize-none bg-transparent px-2.5 pb-1 outline-none placeholder:text-muted-foreground"
				/>
				<div className="flex items-center justify-between gap-2 p-1">
					<span className="pl-1.5 text-xs text-destructive" role={error ? "alert" : undefined} data-testid="canvas-error">
						{error ?? ""}
					</span>
					<div className="ml-auto flex items-center gap-1.5">
						{onHint && (
							<Button type="button" variant="outline" data-testid="canvas-hint" disabled={!canRequestHint({ loaded, compactionRunning, busy, turnBusy })} onClick={() => void hint()} className="h-9 rounded-[6px] px-3 text-sm">
								<LightbulbIcon className="size-4" /> Hint
							</Button>
						)}
						<Button type="button" data-testid="canvas-submit" disabled={!canSubmit} onClick={() => void submit()} className="h-9 rounded-[6px] px-3.5 text-sm font-medium">
							{busy ? "Submitting…" : "Submit"}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * One sent drawing's marks (a submission or a hint snapshot) on the live canvas: cells are anchored to the SENT scene's grid box
 * (fetched, immutable), object ids resolve against the live scene first (so a moved object carries its
 * mark) and fall back to the submitted one; a mark whose object is gone from both is skipped. Once the
 * scenes are in, it reports the marks' boxes (teacherInkBoxes) so the workspace can bring them into view.
 */
function WorkspaceInk({ chatId, drawingId, marks, marksKey, live, theme, onReveal }: { chatId: string; drawingId: string; marks: AnnotationMark[]; marksKey: string; live: DrawingScene; theme: "light" | "dark"; onReveal: (key: string, boxes: Box[]) => void }) {
	const submitted = useDrawingScene(chatId, drawingId);
	const box = useMemo(() => (submitted ? sceneBoundingBox(submitted) : null), [submitted]);
	const merged = useMemo<DrawingScene | null>(() => {
		if (!submitted) return null;
		const ids = new Set(live.objects.map((o) => o.id));
		return { ...live, objects: [...live.objects, ...submitted.objects.filter((o) => !ids.has(o.id))] };
	}, [live, submitted]);
	useEffect(() => {
		if (merged && box) onReveal(marksKey, teacherInkBoxes(marks, merged, box));
	}, [marksKey, merged, box, marks, onReveal]);
	if (!merged || !box) return null;
	return <TeacherInk marks={marks} scene={merged} box={box} space="world" theme={theme} />;
}

/** Re-encodes an image whose long side exceeds IMAGE_MAX_SIDE (PNG stays PNG, others JPEG); small or undecodable images pass through unchanged. */
async function downscaleImage(file: Blob): Promise<{ blob: Blob; w: number; h: number }> {
	const dims = await imageSize(file);
	const to = fitImageSize(dims.w, dims.h);
	if (to.w === dims.w && to.h === dims.h) return { blob: file, ...dims };
	try {
		const bmp = await createImageBitmap(file);
		const c = document.createElement("canvas");
		c.width = to.w;
		c.height = to.h;
		const ctx = c.getContext("2d");
		if (!ctx) return { blob: file, ...dims };
		ctx.drawImage(bmp, 0, 0, to.w, to.h);
		bmp.close();
		const type = file.type === "image/png" ? "image/png" : "image/jpeg";
		const blob = await new Promise<Blob | null>((res) => c.toBlob(res, type, 0.9));
		return blob ? { blob, ...to } : { blob: file, ...dims };
	} catch {
		return { blob: file, ...dims };
	}
}

/** Natural size of an image blob (falls back to 300x200 when it cannot be decoded). */
function imageSize(file: Blob): Promise<{ w: number; h: number }> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve({ w: img.naturalWidth || 300, h: img.naturalHeight || 200 });
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve({ w: 300, h: 200 });
		};
		img.src = url;
	});
}

/** The app theme is the `dark` class on <html>; swatches and the engine follow it live. */
function readTheme(): "light" | "dark" {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
function subscribeTheme(onChange: () => void): () => void {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => observer.disconnect();
}
