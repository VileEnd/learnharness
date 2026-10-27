"use client";

/**
 * The canvas's TYPED OBJECTS as world-positioned overlay editors (canvas workspace, PR 2): plain text,
 * markdown (rendered through MessageResponse), LaTeX (katex, trust off), tables (add/remove row and
 * column, Tab navigation) and images (pasted or uploaded to the assets route, with a corner resize).
 *
 * Each object is a world-sized box scaled by the view (translate + scale), so it tracks pan and zoom
 * exactly like the ink under it. The layer is pointer-transparent except for the boxes themselves, and
 * only while a non-drawing tool is active, so a pen stroke always draws, even across an object.
 * Edits commit on blur (one undo step per edit, not per keystroke). Every editor is a typing surface:
 * Enter belongs to it, never to the window-level submit.
 */

import { useEffect, useRef, useState } from "react";
import katex from "katex";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { DrawingScene, TypedObject } from "@/src/core";
import { isTypedObject } from "@/src/core";
import type { Viewport } from "@/components/pan-zoom";
import { patchObject, removeObject, tableAddCol, tableAddRow, tableNextCell, tableRemoveCol, tableRemoveRow, tableSetCell } from "./object-edit";

/** Render LaTeX with trust off; never throws (a bad source renders as error-coloured text). */
export function renderLatex(src: string): string {
	return katex.renderToString(src, { trust: false, throwOnError: false, displayMode: true });
}

export function assetUrl(chatId: string, assetId: string): string {
	return `/api/chats/${encodeURIComponent(chatId)}/drawings/assets/${encodeURIComponent(assetId)}`;
}

/** Upload an image file to the chat's assets route; returns the asset id. */
export async function uploadAsset(chatId: string, file: Blob, fetchLike: typeof fetch = fetch): Promise<string> {
	const form = new FormData();
	form.set("file", file);
	const res = await fetchLike(`/api/chats/${encodeURIComponent(chatId)}/drawings/assets`, { method: "POST", body: form });
	if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `upload failed (${res.status})`);
	return ((await res.json()) as { assetId: string }).assetId;
}

type Props = {
	chatId: string;
	scene: DrawingScene;
	view: Viewport;
	/** Boxes take pointer events only while a non-drawing tool is active. */
	interactive: boolean;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	onCommit: (next: DrawingScene) => void;
};

export function CanvasObjectsLayer({ chatId, scene, view, interactive, selectedId, onSelect, onCommit }: Props) {
	const typed = scene.objects.filter(isTypedObject);
	return (
		<div data-testid="canvas-objects" className="pointer-events-none absolute inset-0 overflow-hidden">
			{typed.map((o) => (
				<ObjectBox
					key={o.id}
					chatId={chatId}
					scene={scene}
					object={o}
					view={view}
					interactive={interactive}
					selected={selectedId === o.id}
					onSelect={onSelect}
					onCommit={onCommit}
				/>
			))}
		</div>
	);
}

function ObjectBox({ chatId, scene, object: o, view, interactive, selected, onSelect, onCommit }: { chatId: string; scene: DrawingScene; object: TypedObject; view: Viewport; interactive: boolean; selected: boolean; onSelect: (id: string | null) => void; onCommit: (next: DrawingScene) => void }) {
	const drag = useRef<{ mode: "move" | "resize"; px: number; py: number; x: number; y: number; w: number; h: number } | null>(null);
	// Move/resize are live (local) and commit once on release.
	const [live, setLive] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
	const box = live ?? { x: o.x, y: o.y, w: o.w, h: o.h };
	const begin = (mode: "move" | "resize") => (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag.current = { mode, px: e.clientX, py: e.clientY, x: o.x, y: o.y, w: o.w, h: o.h };
		onSelect(o.id);
	};
	const move = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = (e.clientX - d.px) / view.zoom;
		const dy = (e.clientY - d.py) / view.zoom;
		setLive(d.mode === "move" ? { x: d.x + dx, y: d.y + dy, w: d.w, h: d.h } : { x: d.x, y: d.y, w: Math.max(60, d.w + dx), h: Math.max(32, d.h + dy) });
	};
	const end = () => {
		const d = drag.current;
		drag.current = null;
		if (!d || !live) return setLive(null);
		const q = (n: number) => Math.round(n * 10) / 10;
		onCommit(patchObject(scene, o.id, { x: q(live.x), y: q(live.y), w: q(live.w), h: q(live.h) }));
		setLive(null);
	};
	return (
		<div
			data-testid={`canvas-object-${o.id}`}
			data-object-type={o.type}
			onPointerDown={(e) => {
				e.stopPropagation();
				onSelect(o.id);
			}}
			className={cn("absolute left-0 top-0 flex origin-top-left flex-col overflow-hidden rounded-md border bg-card text-card-foreground shadow-sm", interactive ? "pointer-events-auto" : "pointer-events-none", selected ? "border-primary ring-1 ring-primary/40" : "border-border")}
			style={{ width: box.w, height: box.h, transform: `translate(${box.x * view.zoom + view.x}px, ${box.y * view.zoom + view.y}px) scale(${view.zoom})` }}
		>
			<div className="flex shrink-0 cursor-move items-center gap-1 border-b bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground" onPointerDown={begin("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
				<span className="rounded bg-primary/15 px-1 text-primary">{o.id}</span>
				<span className="flex-1 select-none uppercase tracking-wide">{o.type}</span>
				<button type="button" aria-label={`Delete ${o.id}`} data-testid={`canvas-object-delete-${o.id}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onCommit(removeObject(scene, o.id))} className="rounded p-0.5 hover:bg-destructive/15 hover:text-destructive">
					<Trash2Icon className="size-3" />
				</button>
			</div>
			<div className="relative min-h-0 flex-1 overflow-auto">
				{o.type === "text" && <TextEditor object={o} onSource={(source) => onCommit(patchObject(scene, o.id, { source }))} />}
				{o.type === "markdown" && <RenderedEditor object={o} placeholder="Markdown" render={(s) => <MessageResponse>{s}</MessageResponse>} onSource={(source) => onCommit(patchObject(scene, o.id, { source }))} />}
				{o.type === "latex" && <RenderedEditor object={o} placeholder="LaTeX" render={(s) => <div data-testid="canvas-latex" dangerouslySetInnerHTML={{ __html: renderLatex(s) }} />} onSource={(source) => onCommit(patchObject(scene, o.id, { source }))} />}
				{o.type === "table" && <TableEditor cells={o.cells} onCells={(cells) => onCommit(patchObject(scene, o.id, { cells }))} />}
				{o.type === "image" && (
					// eslint-disable-next-line @next/next/no-img-element
					<img src={assetUrl(chatId, o.assetId)} alt="" draggable={false} className="pointer-events-none size-full select-none object-fill" />
				)}
			</div>
			<div data-testid={`canvas-object-resize-${o.id}`} className="absolute bottom-0 right-0 size-3.5 cursor-nwse-resize rounded-tl bg-primary/40" onPointerDown={begin("resize")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
		</div>
	);
}

function TextEditor({ object, onSource }: { object: Extract<TypedObject, { source: string }>; onSource: (s: string) => void }) {
	const [v, setV] = useState(object.source);
	useEffect(() => setV(object.source), [object.source]);
	return <textarea value={v} placeholder="Text" onChange={(e) => setV(e.target.value)} onBlur={() => v !== object.source && onSource(v)} className="lh-input size-full resize-none bg-transparent p-1.5 text-sm outline-none" />;
}

/** Markdown / LaTeX: rendered when idle, a textarea while editing (click to edit; an empty source starts in edit). */
function RenderedEditor({ object, placeholder, render, onSource }: { object: Extract<TypedObject, { source: string }>; placeholder: string; render: (s: string) => React.ReactNode; onSource: (s: string) => void }) {
	const [v, setV] = useState(object.source);
	const [editing, setEditing] = useState(object.source.length === 0);
	useEffect(() => setV(object.source), [object.source]);
	if (editing) {
		return <textarea autoFocus value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => { setEditing(false); if (v !== object.source) onSource(v); }} className="lh-input size-full resize-none bg-transparent p-1.5 font-mono text-sm outline-none" />;
	}
	return (
		<div role="button" tabIndex={0} onClick={() => setEditing(true)} onKeyDown={(e) => e.key === "Enter" && setEditing(true)} className="lh-prose size-full cursor-text p-1.5 text-sm">
			{render(object.source)}
		</div>
	);
}

export function TableEditor({ cells, onCells }: { cells: string[][]; onCells: (next: string[][]) => void }) {
	const refs = useRef(new Map<string, HTMLInputElement>());
	const [local, setLocal] = useState(cells);
	useEffect(() => setLocal(cells), [cells]);
	const commit = (next: string[][]) => {
		setLocal(next);
		onCells(next);
	};
	const focus = (r: number, c: number) => refs.current.get(`${r}:${c}`)?.focus();
	return (
		<div data-testid="canvas-table" className="p-1">
			<table className="w-full border-collapse text-sm">
				<tbody>
					{local.map((row, r) => (
						<tr key={r}>
							{row.map((cell, c) => (
								<td key={c} className="border p-0">
									<input
										ref={(el) => {
											if (el) refs.current.set(`${r}:${c}`, el);
											else refs.current.delete(`${r}:${c}`);
										}}
										value={cell}
										onChange={(e) => setLocal(tableSetCell(local, r, c, e.target.value))}
										onBlur={() => local !== cells && JSON.stringify(local) !== JSON.stringify(cells) && onCells(local)}
										onKeyDown={(e) => {
											if (e.key !== "Tab") return;
											const next = tableNextCell(local, r, c, e.shiftKey);
											if (next) {
												e.preventDefault();
												focus(next.r, next.c);
											}
										}}
										className="lh-input w-full min-w-10 bg-transparent px-1 py-0.5 outline-none"
									/>
								</td>
							))}
							<td className="w-5 border-0 p-0 pl-0.5">
								<button type="button" aria-label={`Remove row ${r + 1}`} onClick={() => commit(tableRemoveRow(local, r))} className="rounded p-0.5 text-muted-foreground hover:text-destructive">
									<XIcon className="size-3" />
								</button>
							</td>
						</tr>
					))}
					<tr>
						{(local[0] ?? []).map((_, c) => (
							<td key={c} className="p-0 pt-0.5 text-center">
								<button type="button" aria-label={`Remove column ${c + 1}`} onClick={() => commit(tableRemoveCol(local, c))} className="rounded p-0.5 text-muted-foreground hover:text-destructive">
									<XIcon className="size-3" />
								</button>
							</td>
						))}
						<td />
					</tr>
				</tbody>
			</table>
			<div className="mt-1 flex gap-1">
				<button type="button" onClick={() => commit(tableAddRow(local))} className="flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
					<PlusIcon className="size-3" /> Row
				</button>
				<button type="button" onClick={() => commit(tableAddCol(local))} className="flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
					<PlusIcon className="size-3" /> Column
				</button>
			</div>
		</div>
	);
}
