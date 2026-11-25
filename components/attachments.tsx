"use client";

/**
 * Images and drawings attached to a message or a thinking field (src/core/attachments.ts).
 *
 * ONE draft hook and ONE strip serve the composer and every thinking field (the question dock's "Your thinking",
 * the reading thinking, the practice thinking). An image is prepared on the device the moment it is added (the
 * photo path: upright, downscaled, re-encoded, so EXIF and GPS never leave), then uploaded to the chat's attachment
 * store, so a send carries only references. A drawing comes from the drawing pad (the canvas workspace in its free
 * mode), already a stored DrawingStore submission. At most MAX_ATTACHMENTS per field; the server enforces the same.
 *
 * The page provides the environment (AttachmentEnvContext): the chat id, whether this device can draw
 * (useCanvasCapable), and how to open the drawing pad.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImagePlusIcon, LoaderIcon, PencilIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ATTACHMENT_ACCEPT, ATTACHMENT_IMAGE_TYPES, MAX_ATTACHMENTS, attachmentImageUrl, type AttachmentRef } from "@/src/core";
import { prepareAttachmentImage, uploadAttachmentImage } from "@/components/canvas/photo-prepare";
import { DrawingThumb } from "@/components/work-cards";

// ─── the environment ────────────────────────────────────────────────────────

export interface AttachmentEnv {
	chatId: string;
	/** The device can draw (useCanvasCapable): the Draw action shows only then. Images are always allowed. */
	canDraw: boolean;
	/** Opens the drawing pad; `onAttach` receives the finished drawing's id. */
	openDrawPad: (onAttach: (drawingId: string) => void) => void;
}

export const AttachmentEnvContext = createContext<AttachmentEnv | null>(null);

export function useAttachmentEnv(): AttachmentEnv | null {
	return useContext(AttachmentEnvContext);
}

// ─── pure decisions (unit-tested) ───────────────────────────────────────────

export const UNSUPPORTED_IMAGE_TEXT = "Only PNG, JPEG, WebP or GIF images can be attached.";
export const TOO_MANY_TEXT = `At most ${MAX_ATTACHMENTS} images or drawings per message.`;

/** Which of these files may be added next to `have` attachments: accepted types only, up to the cap. */
export function admitFiles<T extends { type: string }>(files: readonly T[], have: number): { accepted: T[]; error: string | null } {
	const typed = files.filter((f) => (ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(f.type));
	const room = Math.max(0, MAX_ATTACHMENTS - have);
	const accepted = typed.slice(0, room);
	const error = typed.length < files.length ? UNSUPPORTED_IMAGE_TEXT : typed.length > room ? TOO_MANY_TEXT : null;
	return { accepted, error };
}

/** The image files a paste or a drop carries ([] when it carries none, so plain text pastes stay untouched). */
export function imageFilesOf(data: Pick<DataTransfer, "files"> | null | undefined): File[] {
	return [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

// ─── the draft ──────────────────────────────────────────────────────────────

export type DraftItem =
	| { key: string; kind: "image"; status: "preparing" | "uploading" | "ready"; previewUrl?: string; id?: string }
	| { key: string; kind: "drawing"; status: "ready"; id: string };

export interface AttachmentDraft {
	chatId: string;
	items: DraftItem[];
	/** The references of the ready items, in order: what a send carries. */
	refs: AttachmentRef[];
	/** An image is still being prepared or uploaded: sends wait. */
	pending: boolean;
	/** No room for another attachment. */
	full: boolean;
	error: string | null;
	addFiles: (files: readonly File[]) => void;
	addDrawing: (drawingId: string) => void;
	/** Put back already-stored attachments (a refused send). */
	restore: (refs: readonly AttachmentRef[]) => void;
	remove: (key: string) => void;
	clear: () => void;
}

let seq = 0;
const nextKey = () => `att_${++seq}`;

/** The attachments of one field. `chatId` defaults to the page's (AttachmentEnvContext).
 *  The ref is the single source of the list: every change computes from it and commits ref then state together, so
 *  an add that lands between an upload's progress updates can never overwrite them with a stale list. */
export function useAttachmentDraft(chatIdArg?: string): AttachmentDraft {
	const env = useAttachmentEnv();
	const chatId = chatIdArg ?? env?.chatId ?? "";
	const [items, setItems] = useState<DraftItem[]>([]);
	const [error, setError] = useState<string | null>(null);
	const itemsRef = useRef<DraftItem[]>([]);
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			for (const it of itemsRef.current) if (it.kind === "image" && it.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(it.previewUrl);
		};
	}, []);

	const commit = useCallback((next: DraftItem[]) => {
		itemsRef.current = next;
		if (live.current) setItems(next);
	}, []);

	/** Update one item (null removes it, revoking its local preview). A removed item stays removed. */
	const patch = useCallback(
		(key: string, next: Partial<DraftItem> | null) => {
			const out: DraftItem[] = [];
			for (const it of itemsRef.current) {
				if (it.key !== key) out.push(it);
				else if (next === null) {
					if (it.kind === "image" && it.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(it.previewUrl);
				} else out.push({ ...it, ...next } as DraftItem);
			}
			commit(out);
		},
		[commit],
	);

	const addFiles = useCallback(
		(files: readonly File[]) => {
			const { accepted, error: refused } = admitFiles(files, itemsRef.current.length);
			setError(refused);
			if (accepted.length === 0) return;
			const added = accepted.map((file) => ({ file, item: { key: nextKey(), kind: "image" as const, status: "preparing" as const } }));
			commit([...itemsRef.current, ...added.map((a) => a.item)]);
			for (const { file, item } of added) {
				void (async () => {
					const present = () => live.current && itemsRef.current.some((it) => it.key === item.key);
					try {
						const prepared = await prepareAttachmentImage(file);
						if (!present()) return;
						patch(item.key, { status: "uploading", previewUrl: URL.createObjectURL(prepared.jpeg) });
						const ref = await uploadAttachmentImage(chatId, prepared.jpeg);
						if (present()) patch(item.key, { status: "ready", id: ref.id });
					} catch (e) {
						if (!present()) return;
						patch(item.key, null);
						setError(e instanceof Error ? e.message : "This image could not be added.");
					}
				})();
			}
		},
		[chatId, commit, patch],
	);

	const addDrawing = useCallback(
		(drawingId: string) => {
			if (itemsRef.current.length >= MAX_ATTACHMENTS) {
				setError(TOO_MANY_TEXT);
				return;
			}
			setError(null);
			commit([...itemsRef.current, { key: nextKey(), kind: "drawing", status: "ready", id: drawingId }]);
		},
		[commit],
	);

	/** Put back attachments that are already stored (a refused send): ready cards, previewed from the server. */
	const restore = useCallback(
		(refs: readonly AttachmentRef[]) => {
			const room = MAX_ATTACHMENTS - itemsRef.current.length;
			const back: DraftItem[] = refs.slice(0, Math.max(0, room)).map((ref) =>
				ref.kind === "drawing"
					? { key: nextKey(), kind: "drawing", status: "ready", id: ref.id }
					: { key: nextKey(), kind: "image", status: "ready", id: ref.id, previewUrl: attachmentImageUrl(chatId, ref) },
			);
			if (back.length > 0) commit([...itemsRef.current, ...back]);
		},
		[chatId, commit],
	);

	const remove = useCallback(
		(key: string) => {
			setError(null);
			patch(key, null);
		},
		[patch],
	);

	const clear = useCallback(() => {
		for (const it of itemsRef.current) if (it.kind === "image" && it.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(it.previewUrl);
		commit([]);
		setError(null);
	}, [commit]);

	return useMemo(() => {
		const refs: AttachmentRef[] = [];
		for (const it of items) if (it.status === "ready" && it.id) refs.push({ kind: it.kind, id: it.id });
		return {
			chatId,
			items,
			refs,
			pending: items.some((it) => it.status !== "ready"),
			full: items.length >= MAX_ATTACHMENTS,
			error,
			addFiles,
			addDrawing,
			restore,
			remove,
			clear,
		};
	}, [chatId, items, error, addFiles, addDrawing, restore, remove, clear]);
}

/** Paste and drag-and-drop onto a field: image files join the draft; anything else (plain text) is left alone. */
export function useAttachmentDrop(draft: AttachmentDraft | undefined) {
	const [dragging, setDragging] = useState(false);
	const handlers = useMemo(() => {
		if (!draft) return {};
		const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
		return {
			onPaste: (e: React.ClipboardEvent) => {
				const files = imageFilesOf(e.clipboardData);
				if (files.length === 0) return;
				e.preventDefault();
				draft.addFiles(files);
			},
			onDragOver: (e: React.DragEvent) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
				setDragging(true);
			},
			onDragLeave: (e: React.DragEvent) => {
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
				setDragging(false);
			},
			onDrop: (e: React.DragEvent) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				setDragging(false);
				draft.addFiles([...e.dataTransfer.files]);
			},
		};
	}, [draft]);
	return { dragging, handlers };
}

// ─── the strip (unsent cards) ───────────────────────────────────────────────

/** The removable thumbnail cards of a draft, directly above its field. Renders nothing for an empty draft. */
export function AttachmentStrip({ draft, note, className }: { draft: AttachmentDraft; note?: string; className?: string }) {
	if (draft.items.length === 0 && !draft.error) return null;
	return (
		<div data-testid="attachment-strip" className={cn("flex min-w-0 flex-col gap-1", className)}>
			{draft.items.length > 0 && (
				<ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Attachments">
					{draft.items.map((it, i) => {
						const src = it.kind === "drawing" ? attachmentImageUrl(draft.chatId, { kind: "drawing", id: it.id }) : it.previewUrl;
						const label = it.kind === "drawing" ? `Drawing ${i + 1}` : `Image ${i + 1}`;
						return (
							<li key={it.key} data-testid="attachment-card" data-kind={it.kind} data-status={it.status} className="relative size-14 shrink-0 overflow-hidden rounded-md border border-border/70 bg-white">
								{/* eslint-disable-next-line @next/next/no-img-element -- a local blob or a tenant-scoped route */}
								{src && <img src={src} alt={label} className="size-full object-cover" />}
								{it.status !== "ready" && (
									<span className="absolute inset-0 flex items-center justify-center bg-background/60" role="status" aria-label={it.status === "preparing" ? "Preparing image" : "Uploading image"}>
										<LoaderIcon className="size-4 animate-spin text-muted-foreground" />
									</span>
								)}
								<button
									type="button"
									data-testid="attachment-remove"
									aria-label={`Remove ${label.toLowerCase()}`}
									onClick={() => draft.remove(it.key)}
									className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-colors hover:bg-accent"
								>
									<XIcon className="size-3" />
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{note && draft.items.length > 0 && <span className="text-xs text-muted-foreground">{note}</span>}
			{draft.error && (
				<span role="alert" data-testid="attachment-error" className="text-xs text-destructive">
					{draft.error}
				</span>
			)}
		</div>
	);
}

/** "Add image" (a file picker, several at once) and, on a device that can draw, "Draw". `variant="icon"` is the
 *  composer's square pair; "text" the thinking fields' small labelled buttons. */
export function AttachmentButtons({ draft, variant = "text", disabled = false }: { draft: AttachmentDraft; variant?: "icon" | "text"; disabled?: boolean }) {
	const env = useAttachmentEnv();
	const inputRef = useRef<HTMLInputElement>(null);
	const off = disabled || draft.full;
	const button =
		variant === "icon"
			? "flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
			: "flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";
	return (
		<>
			<input
				ref={inputRef}
				type="file"
				accept={ATTACHMENT_ACCEPT}
				multiple
				data-testid="attachment-input"
				className="sr-only"
				tabIndex={-1}
				onChange={(e) => {
					const files = [...(e.target.files ?? [])];
					e.target.value = ""; // the same file again must fire change
					if (files.length > 0) draft.addFiles(files);
				}}
			/>
			<button type="button" data-testid="attach-image" aria-label="Add image" title="Add image" disabled={off} onClick={() => inputRef.current?.click()} className={button}>
				<ImagePlusIcon className={variant === "icon" ? "size-5" : "size-4"} />
				{variant === "text" && "Add image"}
			</button>
			{env?.canDraw && (
				<button type="button" data-testid="attach-drawing" aria-label="Draw" title="Draw" disabled={off} onClick={() => env.openDrawPad(draft.addDrawing)} className={button}>
					<PencilIcon className={variant === "icon" ? "size-5" : "size-4"} />
					{variant === "text" && "Draw"}
				</button>
			)}
		</>
	);
}

/** A thinking field's attachment row: the strip, then the two buttons under it. */
export function ThinkingAttachments({ draft, disabled, children, className }: { draft: AttachmentDraft; disabled?: boolean; children?: ReactNode; className?: string }) {
	return (
		<div data-testid="thinking-attachments" className={cn("flex min-w-0 flex-col gap-1 px-1.5 pb-0.5", className)}>
			<AttachmentStrip draft={draft} />
			<div className="flex min-w-0 flex-wrap items-center gap-0.5">
				<AttachmentButtons draft={draft} disabled={disabled} />
				{children}
			</div>
		</div>
	);
}

// ─── sent attachments (the transcript) ──────────────────────────────────────

/** The attachments of a sent message or thinking as thumbnails; each opens the full image. A drawing shows the
 *  tutor's marks (DrawingThumb). Wraps at any width, never scrolls the page sideways. */
export function SentAttachments({ chatId: chatIdArg, refs, className }: { chatId?: string; refs: readonly AttachmentRef[]; className?: string }) {
	const env = useAttachmentEnv();
	const chatId = chatIdArg ?? env?.chatId ?? "";
	if (refs.length === 0 || !chatId) return null;
	return (
		<div data-testid="sent-attachments" className={cn("mt-1 flex min-w-0 max-w-full flex-wrap items-start gap-1.5", className)}>
			{refs.map((ref, i) =>
				ref.kind === "drawing" ? (
					<div key={`${ref.kind}:${ref.id}`} className="w-60 min-w-0 max-w-full" data-testid="sent-attachment" data-kind="drawing">
						<DrawingThumb chatId={chatId} drawingId={ref.id} />
					</div>
				) : (
					<a
						key={`${ref.kind}:${ref.id}`}
						href={attachmentImageUrl(chatId, ref)}
						target="_blank"
						rel="noreferrer"
						data-testid="sent-attachment"
						data-kind="image"
						className="block min-w-0 max-w-full"
					>
						{/* eslint-disable-next-line @next/next/no-img-element -- a tenant-scoped route */}
						<img src={attachmentImageUrl(chatId, ref)} alt={`Attached image ${i + 1}`} loading="lazy" className="max-h-32 max-w-full rounded-md border bg-white object-contain" />
					</a>
				),
			)}
		</div>
	);
}
