/**
 * CanvasEngine (canvas workspace, PR 2): the imperative drawing surface. Two stacked canvases (a cached
 * static layer, repainted only when the scene or view changes, and a live stroke layer), pointer handling
 * that never touches React state (the owner learns of a finished stroke through `onChange`), batched redraw
 * on requestAnimationFrame, undo/redo as scene snapshots (max 100) and a PNG export that is always dark ink
 * on white with the region grid overlaid. The pure parts live in ./geometry.ts; zoom/pinch reuse pan-zoom.ts.
 */
import { cellRect, isTypedObject, nextStrokeId, regionGrid, sceneBoundingBox } from "@/src/core";
import type { Box, Brush, DrawingObject, DrawingScene, ShapeKind, StrokeObject } from "@/src/core";
import { pinchView, zoomedGraphView } from "../pan-zoom.ts";
import type { Viewport } from "../pan-zoom.ts";
import { CANVAS_ZOOM_MIN, eraseAt, exportColor, hitTest, objectBox, quantizePoint, screenColor, screenToWorld, strokeOutline, touchRole, visibleObjects } from "./geometry.ts";
import type { CanvasTool, Pt } from "./geometry.ts";

export type { CanvasTool } from "./geometry.ts";
export type CanvasBrush = { color: string; size: number };
export type CanvasEngineOptions = {
	theme?: () => "light" | "dark";
	/** A finished stroke/shape, an erase or an undo/redo: the new scene. */
	onChange?: (scene: DrawingScene) => void;
	/** A tap with a typed-object tool (text, markdown, latex, table, image) at a world point. */
	onPlace?: (tool: CanvasTool, at: Pt) => void;
	onSelect?: (id: string | null) => void;
	onViewChange?: (view: Viewport) => void;
	/** Decoded asset for an image object (null while loading: a placeholder is drawn). */
	getImage?: (assetId: string) => CanvasImageSource | null;
};

const MAX_UNDO = 100;
const SHAPE_TOOLS: readonly string[] = ["line", "arrow", "rect", "ellipse"];
const BRUSH_TOOLS: readonly string[] = ["pen", "pencil", "marker"];
const PLACE_TOOLS: readonly string[] = ["text", "markdown", "latex", "table", "image"];
const ERASER_RADIUS_PX = 10;
const TAP_SLOP_PX = 6;

type Ptr = { type: string; x: number; y: number };
type Colors = (c: string) => string;

export class CanvasEngine {
	private readonly root: HTMLElement;
	private readonly opts: CanvasEngineOptions;
	private readonly staticCanvas = document.createElement("canvas");
	private readonly liveCanvas = document.createElement("canvas");
	private readonly staticCtx: CanvasRenderingContext2D;
	private readonly liveCtx: CanvasRenderingContext2D;
	private readonly resizeObs: ResizeObserver | null;
	private scene: DrawingScene = { version: 1, objects: [] };
	private undoStack: DrawingScene[] = [];
	private redoStack: DrawingScene[] = [];
	private view: Viewport = { zoom: 1, x: 0, y: 0 };
	private size = { w: 0, h: 0, dpr: 1 };
	private tool: CanvasTool = "pen";
	private brush: CanvasBrush = { color: "ink", size: 4 };
	private penSeen = false;
	private pointers = new Map<number, Ptr>();
	private drawing: { pointerId: number; points: [number, number, number][]; start: Pt; cur: Pt; moved: number } | null = null;
	private erasing: { pointerId: number; before: DrawingScene } | null = null;
	private panning: { pointerId: number; last: Pt } | null = null;
	private pinch: { a: number; b: number } | null = null;
	private raf = 0;
	private dirtyStatic = true;
	private dirtyLive = true;
	private destroyed = false;
	private readonly cleanups: (() => void)[] = [];

	constructor(root: HTMLElement, opts: CanvasEngineOptions = {}) {
		this.root = root;
		this.opts = opts;
		Object.assign(root.style, { position: "relative", overflow: "hidden", touchAction: "none", userSelect: "none", webkitUserSelect: "none", webkitTouchCallout: "none" });
		root.style.setProperty("-webkit-user-select", "none");
		root.style.setProperty("-webkit-touch-callout", "none");
		root.style.setProperty("touch-action", "none");
		for (const c of [this.staticCanvas, this.liveCanvas]) Object.assign(c.style, { position: "absolute", inset: "0", width: "100%", height: "100%", touchAction: "none" });
		this.staticCtx = this.staticCanvas.getContext("2d") as CanvasRenderingContext2D;
		this.liveCtx = (supportsDesynchronized() ? this.liveCanvas.getContext("2d", { desynchronized: true }) : this.liveCanvas.getContext("2d")) as CanvasRenderingContext2D;
		root.append(this.staticCanvas, this.liveCanvas);

		const on = <T extends Event>(target: EventTarget, type: string, fn: (e: T) => void, options?: AddEventListenerOptions) => {
			target.addEventListener(type, fn as EventListener, options);
			this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, options));
		};
		// iPad Safari: no loupe, no selection, no page zoom.
		const stop = (e: Event) => e.preventDefault();
		on(root, "touchstart", stop, { passive: false });
		on(root, "gesturestart", stop, { passive: false });
		on(root, "contextmenu", stop);
		on<PointerEvent>(root, "pointerdown", (e) => this.onDown(e));
		on<PointerEvent>(root, "pointermove", (e) => this.onMove(e));
		on<PointerEvent>(root, "pointerup", (e) => this.onUp(e));
		on<PointerEvent>(root, "pointercancel", (e) => this.onUp(e, true));
		on<WheelEvent>(root, "wheel", (e) => this.onWheel(e), { passive: false });
		this.resizeObs = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
		this.resizeObs?.observe(root);
		this.resize();
	}

	// ---- public API ----

	setScene(scene: DrawingScene): void {
		this.scene = scene;
		this.undoStack = [];
		this.redoStack = [];
		this.drawing = null;
		this.dirtyStatic = this.dirtyLive = true;
		this.schedule();
	}
	getScene(): DrawingScene {
		return this.scene;
	}
	/** An edit made OUTSIDE the engine (a typed-object overlay, a placement):
	 *  the new scene joins the undo stack like a finished stroke. */
	applyScene(next: DrawingScene): void {
		this.commit(next);
	}
	setTool(tool: CanvasTool): void {
		this.tool = tool;
		this.drawing = null;
		this.dirtyLive = true;
		this.schedule();
	}
	setBrush(b: Partial<CanvasBrush>): void {
		this.brush = { ...this.brush, ...b };
	}
	getView(): Viewport {
		return this.view;
	}
	setView(view: Viewport): void {
		this.view = view;
		this.dirtyStatic = this.dirtyLive = true;
		this.opts.onViewChange?.(view);
		this.schedule();
	}
	/** Re-render after the theme flipped. */
	refresh(): void {
		this.dirtyStatic = this.dirtyLive = true;
		this.schedule();
	}
	undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.scene);
		this.replace(prev);
	}
	redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.scene);
		this.replace(next);
	}

	/** Scene bounding box at 2x (long side at most 2048 px), dark ink on white, with the region grid and `oN` badges. */
	exportPng(): Promise<Blob> {
		const box: Box = sceneBoundingBox(this.scene) ?? { x: 0, y: 0, w: 256, h: 256 };
		const scale = Math.min(2, 2048 / Math.max(box.w, box.h));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(box.w * scale));
		canvas.height = Math.max(1, Math.round(box.h * scale));
		const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
		this.paintObjects(ctx, visibleObjects(this.scene, box), exportColor);
		this.paintGrid(ctx, box, scale);
		return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png"));
	}

	destroy(): void {
		this.destroyed = true;
		if (this.raf) cancelAnimationFrame(this.raf);
		for (const fn of this.cleanups) fn();
		this.resizeObs?.disconnect();
		this.staticCanvas.remove();
		this.liveCanvas.remove();
	}

	// ---- scene mutation ----

	private commit(next: DrawingScene): void {
		this.undoStack.push(this.scene);
		if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
		this.redoStack = [];
		this.replace(next);
	}
	private replace(next: DrawingScene): void {
		this.scene = next;
		this.dirtyStatic = true;
		this.schedule();
		this.opts.onChange?.(next);
	}
	private nextZ(): number {
		let z = 0;
		for (const o of this.scene.objects) if (o.z >= z) z = o.z + 1;
		return z;
	}

	// ---- pointer handling ----

	private local(e: { clientX: number; clientY: number }): Pt {
		const r = this.root.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}
	private touchCount(): number {
		let n = 0;
		for (const p of this.pointers.values()) if (p.type === "touch") n++;
		return n;
	}
	private penDown(): boolean {
		for (const p of this.pointers.values()) if (p.type === "pen") return true;
		return false;
	}

	private onDown(e: PointerEvent): void {
		if (e.pointerType === "pen") this.penSeen = true;
		const at = this.local(e);
		// A palm resting beside a pen stroke is ignored.
		if (e.pointerType === "touch" && this.penDown()) return;
		this.pointers.set(e.pointerId, { type: e.pointerType, x: at.x, y: at.y });
		try { this.root.setPointerCapture(e.pointerId); } catch { /* synthetic or released pointer */ }

		if (e.pointerType === "touch") {
			const count = this.touchCount();
			if (touchRole(this.penSeen, count) === "pan") {
				if (count >= 2) {
					this.drawing = null; // a second finger turns a started stroke into a pinch
					this.dirtyLive = true;
					this.panning = null;
					const ids = [...this.pointers].filter(([, p]) => p.type === "touch").map(([id]) => id);
					this.pinch = { a: ids[0] as number, b: ids[1] as number };
				} else this.panning = { pointerId: e.pointerId, last: at };
				this.schedule();
				return;
			}
		} else if (this.tool === "pan" || e.button === 1) {
			this.panning = { pointerId: e.pointerId, last: at };
			return;
		}
		this.begin(e, at);
	}

	private begin(e: PointerEvent, at: Pt): void {
		const w = screenToWorld(this.view, at);
		const tool = this.tool;
		if (tool === "pan") { this.panning = { pointerId: e.pointerId, last: at }; return; }
		if (tool === "eraser") {
			this.erasing = { pointerId: e.pointerId, before: this.scene };
			this.eraseTo(w);
			return;
		}
		if (tool === "select" || PLACE_TOOLS.includes(tool) || BRUSH_TOOLS.includes(tool) || SHAPE_TOOLS.includes(tool)) {
			const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
			this.drawing = { pointerId: e.pointerId, points: [quantizePoint(w.x, w.y, pressure)], start: at, cur: at, moved: 0 };
			this.dirtyLive = true;
			this.schedule();
		}
	}

	private onMove(e: PointerEvent): void {
		const known = this.pointers.get(e.pointerId);
		if (!known) return;
		const at = this.local(e);
		const prev = { x: known.x, y: known.y };
		known.x = at.x;
		known.y = at.y;

		if (this.pinch) {
			const a = this.pointers.get(this.pinch.a);
			const b = this.pointers.get(this.pinch.b);
			if (!a || !b || (e.pointerId !== this.pinch.a && e.pointerId !== this.pinch.b)) return;
			const before: [Pt, Pt] = e.pointerId === this.pinch.a ? [prev, { x: b.x, y: b.y }] : [{ x: a.x, y: a.y }, prev];
			this.applyView(pinchView(this.view, before, [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], CANVAS_ZOOM_MIN, this.fitBox(), this.size));
			return;
		}
		if (this.panning?.pointerId === e.pointerId) {
			this.applyView({ ...this.view, x: this.view.x + at.x - this.panning.last.x, y: this.view.y + at.y - this.panning.last.y });
			this.panning.last = at;
			return;
		}
		if (this.erasing?.pointerId === e.pointerId) {
			this.eraseTo(screenToWorld(this.view, at));
			return;
		}
		const d = this.drawing;
		if (!d || d.pointerId !== e.pointerId) return;
		d.moved = Math.max(d.moved, Math.hypot(at.x - d.start.x, at.y - d.start.y));
		d.cur = at;
		if (BRUSH_TOOLS.includes(this.tool)) {
			const events = e.pointerType === "pen" && typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
			for (const ev of events.length ? events : [e]) {
				const w = screenToWorld(this.view, this.local(ev));
				const pressure = e.pointerType === "pen" && ev.pressure > 0 ? ev.pressure : 0.5;
				d.points.push(quantizePoint(w.x, w.y, pressure));
			}
		}
		this.dirtyLive = true;
		this.schedule();
	}

	private onUp(e: PointerEvent, cancelled = false): void {
		const known = this.pointers.get(e.pointerId);
		this.pointers.delete(e.pointerId);
		try { this.root.releasePointerCapture(e.pointerId); } catch { /* already released */ }
		if (!known) return;
		if (this.pinch && (e.pointerId === this.pinch.a || e.pointerId === this.pinch.b)) this.pinch = null;
		if (this.panning?.pointerId === e.pointerId) this.panning = null;
		if (this.erasing?.pointerId === e.pointerId) {
			const { before } = this.erasing;
			this.erasing = null;
			if (this.scene !== before) {
				this.undoStack.push(before);
				if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
				this.redoStack = [];
				this.opts.onChange?.(this.scene);
			}
			return;
		}
		const d = this.drawing;
		if (!d || d.pointerId !== e.pointerId) return;
		this.drawing = null;
		this.dirtyLive = true;
		this.schedule();
		if (cancelled) return;
		this.finish(d);
	}

	private finish(d: NonNullable<CanvasEngine["drawing"]>): void {
		const tool = this.tool;
		const endW = screenToWorld(this.view, d.cur);
		const startW = screenToWorld(this.view, d.start);
		if (tool === "select") {
			if (d.moved <= TAP_SLOP_PX) this.opts.onSelect?.(hitTest(this.scene, startW, TAP_SLOP_PX / this.view.zoom));
		} else if (PLACE_TOOLS.includes(tool)) {
			if (d.moved <= TAP_SLOP_PX) this.opts.onPlace?.(tool, { x: Math.round(startW.x * 10) / 10, y: Math.round(startW.y * 10) / 10 });
		} else if (BRUSH_TOOLS.includes(tool)) {
			const obj: StrokeObject = { id: nextStrokeId(this.scene), z: this.nextZ(), type: "stroke", brush: tool as Brush, color: this.brush.color, size: this.brush.size, points: d.points };
			this.commit({ ...this.scene, objects: [...this.scene.objects, obj] });
		} else if (SHAPE_TOOLS.includes(tool) && d.moved > TAP_SLOP_PX) {
			const [x1, y1] = quantizePoint(startW.x, startW.y, 0);
			const [x2, y2] = quantizePoint(endW.x, endW.y, 0);
			const obj: DrawingObject = { id: nextStrokeId(this.scene), z: this.nextZ(), type: "shape", shape: tool as ShapeKind, color: this.brush.color, strokeWidth: this.brush.size, x1, y1, x2, y2 };
			this.commit({ ...this.scene, objects: [...this.scene.objects, obj] });
		}
	}

	private eraseTo(w: Pt): void {
		const next = eraseAt(this.scene, w, ERASER_RADIUS_PX / this.view.zoom);
		if (next === this.scene) return;
		this.scene = next;
		this.dirtyStatic = true;
		this.schedule();
	}

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) {
			this.applyView(zoomedGraphView(this.view, Math.exp(-e.deltaY * 0.01), CANVAS_ZOOM_MIN, this.local(e), this.fitBox(), this.size));
		} else this.applyView({ ...this.view, x: this.view.x - e.deltaX, y: this.view.y - e.deltaY });
	}

	/** A box that fits the viewport exactly at the zoom floor, so the floor re-fit lands on the origin instead of jumping. */
	private fitBox(): { w: number; h: number } {
		return { w: this.size.w / CANVAS_ZOOM_MIN, h: this.size.h / CANVAS_ZOOM_MIN };
	}
	private applyView(view: Viewport): void {
		if (view === this.view) return;
		this.view = view;
		this.dirtyStatic = this.dirtyLive = true;
		this.opts.onViewChange?.(view);
		this.schedule();
	}

	// ---- rendering ----

	private resize(): void {
		const r = this.root.getBoundingClientRect();
		const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
		this.size = { w: r.width, h: r.height, dpr };
		for (const c of [this.staticCanvas, this.liveCanvas]) {
			c.width = Math.max(1, Math.round(r.width * dpr));
			c.height = Math.max(1, Math.round(r.height * dpr));
		}
		this.dirtyStatic = this.dirtyLive = true;
		this.schedule();
	}
	private schedule(): void {
		if (this.raf || this.destroyed) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			if (this.destroyed) return;
			if (this.dirtyStatic) this.paintStatic();
			if (this.dirtyLive) this.paintLive();
		});
	}
	private colors(): Colors {
		const theme = this.opts.theme?.() ?? "light";
		return (c) => screenColor(c, theme);
	}
	private worldBox(): Box {
		const { zoom, x, y } = this.view;
		return { x: -x / zoom, y: -y / zoom, w: this.size.w / zoom, h: this.size.h / zoom };
	}
	private applyTransform(ctx: CanvasRenderingContext2D): void {
		const { dpr } = this.size;
		const { zoom, x, y } = this.view;
		ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);
	}

	private paintStatic(): void {
		this.dirtyStatic = false;
		const ctx = this.staticCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
		this.applyTransform(ctx);
		this.paintObjects(ctx, visibleObjects(this.scene, this.worldBox()), this.colors());
	}

	private paintLive(): void {
		this.dirtyLive = false;
		const ctx = this.liveCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
		const d = this.drawing;
		if (!d) return;
		this.applyTransform(ctx);
		const colors = this.colors();
		if (BRUSH_TOOLS.includes(this.tool)) {
			this.paintStroke(ctx, { id: "live", z: 0, type: "stroke", brush: this.tool as Brush, color: this.brush.color, size: this.brush.size, points: d.points }, colors);
		} else if (SHAPE_TOOLS.includes(this.tool) && d.moved > TAP_SLOP_PX) {
			const a = screenToWorld(this.view, d.start);
			const b = screenToWorld(this.view, d.cur);
			this.paintShape(ctx, { id: "live", z: 0, type: "shape", shape: this.tool as ShapeKind, color: this.brush.color, strokeWidth: this.brush.size, x1: a.x, y1: a.y, x2: b.x, y2: b.y }, colors);
		}
	}

	private paintObjects(ctx: CanvasRenderingContext2D, objects: DrawingObject[], colors: Colors): void {
		for (const o of objects) {
			if (o.type === "stroke") this.paintStroke(ctx, o, colors);
			else if (o.type === "shape") this.paintShape(ctx, o, colors);
			else this.paintTyped(ctx, o, colors);
		}
	}

	private paintStroke(ctx: CanvasRenderingContext2D, o: StrokeObject, colors: Colors): void {
		if (!o.points.length) return;
		const outline = strokeOutline(o.points, o.brush, o.size);
		ctx.save();
		ctx.fillStyle = colors(o.color);
		ctx.globalAlpha = o.brush === "marker" ? 0.45 : o.brush === "pencil" ? 0.85 : 1;
		const path = new Path2D();
		if (outline.length < 2) {
			const p = o.points[0] as [number, number, number];
			path.arc(p[0], p[1], o.size / 2, 0, Math.PI * 2);
		} else {
			const first = outline[0] as [number, number];
			path.moveTo(first[0], first[1]);
			for (let i = 1; i < outline.length; i++) {
				const a = outline[i] as [number, number];
				const b = outline[(i + 1) % outline.length] as [number, number];
				path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
			}
			path.closePath();
		}
		ctx.fill(path);
		ctx.restore();
	}

	private paintShape(ctx: CanvasRenderingContext2D, o: Extract<DrawingObject, { type: "shape" }>, colors: Colors): void {
		ctx.save();
		ctx.strokeStyle = colors(o.color);
		ctx.fillStyle = colors(o.color);
		ctx.lineWidth = o.strokeWidth;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.beginPath();
		if (o.shape === "rect") ctx.rect(Math.min(o.x1, o.x2), Math.min(o.y1, o.y2), Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1));
		else if (o.shape === "ellipse") ctx.ellipse((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, Math.abs(o.x2 - o.x1) / 2, Math.abs(o.y2 - o.y1) / 2, 0, 0, Math.PI * 2);
		else {
			ctx.moveTo(o.x1, o.y1);
			ctx.lineTo(o.x2, o.y2);
			if (o.shape === "arrow") {
				const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
				const head = Math.max(10, o.strokeWidth * 4);
				for (const s of [-1, 1]) {
					ctx.moveTo(o.x2, o.y2);
					ctx.lineTo(o.x2 - head * Math.cos(ang + s * 0.45), o.y2 - head * Math.sin(ang + s * 0.45));
				}
			}
		}
		ctx.stroke();
		ctx.restore();
	}

	/** Typed objects on the canvas: a plain-text rendition (the rich DOM view belongs to the workspace overlay). */
	private paintTyped(ctx: CanvasRenderingContext2D, o: Exclude<DrawingObject, StrokeObject | { type: "shape" }>, colors: Colors): void {
		const b = objectBox(o);
		const ink = colors("ink");
		ctx.save();
		ctx.strokeStyle = colors("gray");
		ctx.lineWidth = 1;
		ctx.fillStyle = ink;
		ctx.textBaseline = "top";
		ctx.beginPath();
		ctx.rect(b.x, b.y, b.w, b.h);
		ctx.clip();
		if (o.type === "image") {
			const img = this.opts.getImage?.(o.assetId) ?? null;
			if (img) ctx.drawImage(img, b.x, b.y, b.w, b.h);
			else ctx.strokeRect(b.x, b.y, b.w, b.h);
		} else if (o.type === "table") {
			const rows = o.cells.length || 1;
			const cols = Math.max(1, ...o.cells.map((r) => r.length));
			const cw = b.w / cols, ch = b.h / rows;
			ctx.font = "14px sans-serif";
			ctx.beginPath();
			for (let r = 0; r <= rows; r++) { ctx.moveTo(b.x, b.y + r * ch); ctx.lineTo(b.x + b.w, b.y + r * ch); }
			for (let c = 0; c <= cols; c++) { ctx.moveTo(b.x + c * cw, b.y); ctx.lineTo(b.x + c * cw, b.y + b.h); }
			ctx.stroke();
			o.cells.forEach((row, r) => row.forEach((cell, c) => ctx.fillText(cell.split("\n")[0] ?? "", b.x + c * cw + 4, b.y + r * ch + 4, cw - 8)));
		} else {
			ctx.font = o.type === "latex" ? "15px monospace" : "16px sans-serif";
			let y = b.y + 4;
			for (const line of o.source.split("\n")) {
				ctx.fillText(line, b.x + 4, y, Math.max(1, b.w - 8));
				y += 20;
				if (y > b.y + b.h) break;
			}
		}
		ctx.restore();
	}

	/** Faint region grid, column letters along the top, row numbers on the left, `oN` badges on typed objects. */
	private paintGrid(ctx: CanvasRenderingContext2D, box: Box, scale: number): void {
		const grid = regionGrid(box);
		const px = 1 / scale;
		ctx.save();
		ctx.strokeStyle = "rgba(0,0,0,0.14)";
		ctx.lineWidth = px;
		ctx.beginPath();
		for (let c = 0; c <= grid.cols; c++) { ctx.moveTo(box.x + c * grid.cellW, box.y); ctx.lineTo(box.x + c * grid.cellW, box.y + box.h); }
		for (let r = 0; r <= grid.rows; r++) { ctx.moveTo(box.x, box.y + r * grid.cellH); ctx.lineTo(box.x + box.w, box.y + r * grid.cellH); }
		ctx.stroke();
		ctx.fillStyle = "rgba(0,0,0,0.55)";
		ctx.font = `${12 * px}px sans-serif`;
		ctx.textBaseline = "top";
		for (let c = 0; c < grid.cols; c++) {
			const rect = cellRect(grid, box, `${"ABCDEFGH"[c]}1`) as Box;
			ctx.fillText("ABCDEFGH"[c] as string, rect.x + 3 * px, box.y + 2 * px);
		}
		for (let r = 0; r < grid.rows; r++) ctx.fillText(String(r + 1), box.x + 3 * px, box.y + r * grid.cellH + 14 * px);
		for (const o of this.scene.objects) {
			if (!isTypedObject(o)) continue;
			const b = objectBox(o);
			const label = o.id;
			ctx.font = `bold ${11 * px}px sans-serif`;
			const w = ctx.measureText(label).width + 8 * px;
			ctx.fillStyle = "#1d4ed8";
			ctx.fillRect(b.x, b.y, w, 15 * px);
			ctx.fillStyle = "#ffffff";
			ctx.fillText(label, b.x + 4 * px, b.y + 2 * px);
		}
		ctx.restore();
	}
}

function supportsDesynchronized(): boolean {
	try {
		const probe = document.createElement("canvas").getContext("2d", { desynchronized: true });
		return !!probe && typeof probe.getContextAttributes === "function" && probe.getContextAttributes().desynchronized === true;
	} catch {
		return false;
	}
}

