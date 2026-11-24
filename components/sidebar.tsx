"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MenuShell } from "@/components/menu-shell";
import { okJson } from "@/components/ok-json";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { DeleteFolderDialog } from "@/components/delete-folder-dialog";
import type { ChatDeleteMode } from "@/src/core";
import { BrainIcon, ChevronLeftIcon, ChevronRightIcon, CheckIcon, DumbbellIcon, FolderIcon, FolderPlusIcon, LibraryIcon, MoreHorizontalIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { ActivitySection } from "@/components/activity-dock";
import { AccountLine } from "@/components/account-line";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { LhMark } from "@/components/lh-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { classifySwipe, resolveSidebarOpen, sidebarStorageKey, WIDE_QUERY } from "@/components/sidebar-state";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { BottomTabs } from "@/components/bottom-tabs";
import { fuzzyScore } from "@/src/core";
import { useVisualViewport } from "@/components/use-visual-viewport";
import { useBackDismiss } from "@/components/use-back-dismiss";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem, GroupedSessions, SessionFolder, SessionFoldersView, SessionKindFilter } from "@/src/core";
import { FOLDER_NAME_MAX, groupSessions, normalizeFolderName } from "@/src/core";
import { kbdEventForAction } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useAppearance } from "@/components/settings/appearance";

/**
 * Toggleable sidebar — NOT a modal: no focus theft. From `md` up it sits
 * inline next to the content and can stay open while working in a session.
 * Below `md` (phones) it is a fixed slide-in drawer over the app with a
 * backdrop; a swipe from the left edge opens it, a swipe left or a route
 * change closes it. Open state persists across pages (provider lives in the
 * root layout) and across reloads (localStorage) — under separate keys for
 * the two layouts, so a phone and a desktop never fight over one value.
 */

const SidebarContext = createContext<{
	open: boolean;
	toggle: () => void;
	/** Below md: the sidebar is an overlay drawer, not an inline panel. */
	narrow: boolean;
	setOpen: (next: boolean) => void;
}>({
	open: false,
	toggle: () => {},
	narrow: false,
	setOpen: () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	// Start closed so server and client first-render agree (no hydration
	// mismatch); the stored value is applied after mount.
	const [open, setOpenState] = useState(false);
	const [narrow, setNarrow] = useState(false);
	const [mounted, setMounted] = useState(false);
	const narrowRef = useRef(false);
	const openRef = useRef(false);
	openRef.current = open;
	narrowRef.current = narrow;
	const pathname = usePathname();

	useEffect(() => {
		const mq = window.matchMedia(WIDE_QUERY);
		const apply = () => {
			const wide = mq.matches;
			narrowRef.current = !wide;
			setNarrow(!wide);
			setOpenState(resolveSidebarOpen(localStorage.getItem(sidebarStorageKey(wide)), wide));
			setMounted(true);
		};
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, []);

	const setOpen = useCallback((next: boolean) => {
		localStorage.setItem(sidebarStorageKey(!narrowRef.current), next ? "1" : "0");
		setOpenState(next);
	}, []);

	const toggle = useCallback(() => setOpen(!openRef.current), [setOpen]);

	// The drawer covers the page: navigating (a session row, the tabs, a
	// link) closes it. Not on first render — that is the stored state.
	const lastPathRef = useRef(pathname);
	useEffect(() => {
		if (lastPathRef.current === pathname) return;
		lastPathRef.current = pathname;
		if (narrowRef.current && openRef.current) setOpen(false);
	}, [pathname, setOpen]);

	// Edge swipe opens, swipe left closes (phones only; touch only).
	useEffect(() => {
		if (!narrow) return;
		let start: { x: number; y: number } | null = null;
		const onStart = (e: TouchEvent) => {
			const t = e.touches.length === 1 ? e.touches[0] : undefined;
			start = t ? { x: t.clientX, y: t.clientY } : null;
		};
		const onEnd = (e: TouchEvent) => {
			const t = e.changedTouches[0];
			const from = start;
			start = null;
			if (!from || !t) return;
			const intent = classifySwipe(from, { x: t.clientX, y: t.clientY }, openRef.current);
			if (intent) setOpen(intent === "open");
		};
		window.addEventListener("touchstart", onStart, { passive: true });
		window.addEventListener("touchend", onEnd, { passive: true });
		return () => {
			window.removeEventListener("touchstart", onStart);
			window.removeEventListener("touchend", onEnd);
		};
	}, [narrow, setOpen]);

	// ⌘B: the global shortcut dispatches kbdEventForAction("toggle-sidebar")
	// and the context answers on exactly that name — the shared spelling
	// is the fix for the interlude bug (the listener sat on the pre-
	// convention name "lh:toggle-sidebar" while the dispatcher sent
	// "lh:kbd-toggle-sidebar", so ⌘B silently did nothing; owner
	// 2026-09-25).
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const onToggle = () => toggle();
		window.addEventListener(event, onToggle);
		return () => window.removeEventListener(event, onToggle);
	}, [toggle]);

	return (
		<SidebarContext.Provider value={{ open, toggle, narrow, setOpen }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity,translate]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/** Hamburger for page headers — only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount) —
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses —
 *  no popping in either direction. */
export function SidebarToggle() {
	const { open, toggle, narrow } = useSidebar();
	// Below md the drawer overlays the page, so the slot never collapses.
	return (
		<span
			className={cn(
				"sidebar-motion relative flex h-9 w-9 shrink-0 overflow-hidden duration-200",
				open ? "md:w-0 md:-mr-3" : "md:mr-0",
			)}
		>
			<Hint label="Open sidebar" action="toggle-sidebar">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open && !narrow}
				tabIndex={open && !narrow ? -1 : 0}
				onClick={toggle}
				className={cn("sidebar-motion duration-200", open ? "md:pointer-events-none md:opacity-0" : "opacity-100")}
			>
				{/* Owner, round 6: size-4, SAME as the close glyph — the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
			</Hint>
		</span>
	);
}

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a teach turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * phases only advance (all sessions end in Teaching — phase-as-signal was
 * decoration, now retired app-wide), and question-pending is the dominant
 * RESTING state of real sessions — a resting state has no scan value, so
 * the meta line's "Waiting for input" text carries it. Idle is the
 * absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line: the state when a state exists (waiting/working),
 *  otherwise just how long ago. The message count is DROPPED (owner,
 *  typography round 5): it informed no decision — clutter. messageCount
 *  still rides the API payload, so this is a one-line flip back if it's
 *  ever wanted. */
/** The state the meta line names, without its time: what the compact
 *  list (no meta line) shows as a status dot. null = nothing to flag. */
function sessionAttention(chat: ChatListItem): string | null {
	if (chat.compacting) return "Compacting context";
	if (chat.pendingQuestion) return "Waiting for input";
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) return "Problem waiting";
	return null;
}

function sessionMeta(chat: ChatListItem): string {
	if (chat.compacting) return `Compacting context · ${timeAgo(chat.updatedAt)}`;
	if (chat.pendingQuestion) return `Waiting for input · ${timeAgo(chat.updatedAt)}`;
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) {
		return `Problem waiting · ${timeAgo(chat.updatedAt)}`;
	}
	if (chat.busy) return "Working…";
	return timeAgo(chat.updatedAt);
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta. Exported for render tests — pure function of the
 * list item.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
	kbdSelected = false,
	onContextMenu,
	onMenu,
	compact = false,
}: {
	chat: ChatListItem;
	active: boolean;
	/** Compact session list (Appearance, owner 2026-11-24): one line per
	 *  session (no meta line), a fixed short row, and hover without a fade.
	 *  Off = today's two-line rows. */
	compact?: boolean;
	onOpen: () => void;
	/** Keyboard-cycle highlight (shortcut wave A: Alt+↑/↓ + Alt+Enter) —
	 *  visually distinct from the active session, which stays filled. */
	kbdSelected?: boolean;
	/** Right-click opens the context menu (wave 6: Rename / Delete). */
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	/** The "⋯" button opens the same menu without a right-click — iOS
	 *  never fires contextmenu on long-press. Hover-only on desktop,
	 *  always visible on touch. */
	onMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const attention = sessionAttention(chat);
	return (
		<div className="group relative mb-0.5">
		<button
			type="button"
			onClick={onOpen}
			onContextMenu={onContextMenu}
			data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
			className={cn(
				"relative flex w-full items-center gap-2 rounded-lg px-3 text-left hover:bg-accent",
				compact ? SIDEBAR_COMPACT_ROW : "py-2 transition-colors",
				onMenu && "pointer-coarse:pr-11",
				active && "bg-accent",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
			)}
		>
			<SessionStatus busy={chat.busy || chat.compacting} />
			<span className="min-w-0 flex-1">
				{/* Titles are the learner's/teacher's WORDS — Source Sans 3, the
				    same voice the words were typed in (every input is lh-prose);
				    the meta line below stays JetBrains Mono (machine data). One
				    rule, finally applied to the picker too (owner, typography
				    round): mono = chrome, Source Sans = human words. The
				    compact list keeps the same face and size, on one line. */}
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{chat.title}</span>
				{!compact && <span className="block text-xs text-muted-foreground">{sessionMeta(chat)}</span>}
			</span>
			{/* The dumbbell rides the FAR RIGHT (owner round 6, 2026-10-05) —
			    was left of the name; right-aligned keeps the titles flush with
			    the teaching rows and reads cleaner. */}
			{(chat.kind ?? "teach") === "practice" && (
				<DumbbellIcon className="size-3.5 shrink-0 text-muted-foreground-70" aria-label="Practice session" />
			)}
			{/* Compact rows have no meta line: the state it would name
			    (waiting, problem, compacting) rides here as a dot. */}
			{compact && attention && (
				<span
					data-testid="session-status-dot"
					role="img"
					title={attention}
					aria-label={attention}
					className="size-2 shrink-0 rounded-full bg-warning"
				/>
			)}
		</button>
		{onMenu && (
			<button
				type="button"
				aria-label="Session actions"
				data-testid="session-row-menu"
				onClick={onMenu}
				className={cn(
					"absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:bg-accent group-hover:opacity-100 pointer-coarse:opacity-100",
					// Compact: the button fits inside the short row (never over a
					// neighbour) and appears without a fade, like the row's hover.
					compact ? "size-7 pointer-coarse:size-9" : "size-8 transition-opacity pointer-coarse:size-10",
				)}
			>
				<MoreHorizontalIcon className="size-4" />
			</button>
		)}
		</div>
	);
}

/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The row keeps the list's density mid-edit: the meta line stays in the
 *  two-line list and is absent in the compact one, so the height never
 *  changes. */
export function RenameRow({ chat, onCommit, onCancel, compact = false }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void; compact?: boolean }) {
	const [draft, setDraft] = useState(chat.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div
			data-testid="session-rename-row"
			className={cn("relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3", compact ? SIDEBAR_COMPACT_ROW : "py-2")}
		>
			{/* NOTHING MOVES (owner, polish round): an idle row renders no
			    status spacer (SessionStatus is null when not busy), so the
			    title starts at the row's own px-3 — 12px in. The old rename
			    row always carried a 14px spacer + gap + the input's border
			    and padding, landing the text ~41px in (and the meta with
			    it). The input here is borderless and padding-free at the
			    exact title x; the underline is the only editing cue. */}
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // discard, not also the sidebar/chat chains
							onCancel();
						}
					}}
					aria-label="Rename session"
					data-testid="session-rename-input"
					className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
				{!compact && <span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>}
			</span>
		</div>
	);
}

/** The compact list's row (Appearance → Compact session list): one short
 *  line in the title's own font and size; a minimum height (taller on
 *  touch so the actions button and the finger both fit) that a large
 *  reading size may grow past. Exported for tests. */
export const SIDEBAR_COMPACT_ROW = "min-h-8 py-1 pointer-coarse:min-h-10";

/** The inline folder-name row (create and rename), in the session rename's
 *  manner: select-all on entry, Enter/blur commits, Esc discards. */
export function FolderNameRow({
	initial,
	onCommit,
	onCancel,
	compact = false,
	label,
	error = null,
}: {
	initial: string;
	onCommit: (next: string) => void;
	onCancel: () => void;
	compact?: boolean;
	label: string;
	/** Why the last commit was refused: shown under the input, which stays open. */
	error?: string | null;
}) {
	const [draft, setDraft] = useState(initial);
	const inputRef = useRef<HTMLInputElement | null>(null);
	/** One commit per attempt: Enter blurs, and the blur must not commit twice. */
	const pending = useRef(false);
	const refused = useRef<string | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	useEffect(() => {
		if (!error) return;
		pending.current = false;
		refused.current = draft;
		inputRef.current?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only a new refusal re-arms the row
	}, [error]);
	return (
		<div data-testid="folder-name-row" className={cn("relative mb-0.5 w-full rounded-lg bg-accent px-3", compact ? SIDEBAR_COMPACT_ROW : "py-1.5")}>
			<span className="flex items-center gap-2">
				<FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<input
					ref={inputRef}
					value={draft}
					maxLength={FOLDER_NAME_MAX}
					spellCheck={false}
					placeholder="Folder name"
					aria-invalid={error ? true : undefined}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => {
						if (pending.current) return;
						// Leaving a refused name as it was gives up on it.
						if (error && draft === refused.current) {
							onCancel();
							return;
						}
						pending.current = true;
						onCommit(draft);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							if (error && draft === refused.current) return; // still the refused name
							e.currentTarget.blur();
						}
						if (e.key === "Escape") {
							e.stopPropagation();
							pending.current = true;
							onCancel();
						}
					}}
					aria-label={label}
					data-testid="folder-name-input"
					className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 font-prose text-(length:--lh-prose-size) text-foreground outline-none placeholder:text-muted-foreground-60"
				/>
			</span>
			{error && (
				<span role="alert" data-testid="folder-name-error" className="mt-1 block text-xs text-error">
					{error}
				</span>
			)}
		</div>
	);
}

/** A folder's header row: chevron, name, how many sessions it shows (the
 *  kind filter's count), and the "⋯" actions button. A click folds it; on a
 *  fine pointer a session can be dropped on it. */
export function FolderHeader({
	folder,
	count,
	expanded,
	compact = false,
	dropActive = false,
	onToggle,
	onMenu,
	onContextMenu,
	dropHandlers,
}: {
	folder: SessionFolder;
	count: number;
	expanded: boolean;
	compact?: boolean;
	dropActive?: boolean;
	onToggle: () => void;
	onMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	dropHandlers?: React.HTMLAttributes<HTMLDivElement>;
}) {
	return (
		<div className="group relative mb-0.5" data-folder-id={folder.id} {...dropHandlers}>
			<button
				type="button"
				onClick={onToggle}
				onContextMenu={onContextMenu}
				aria-expanded={expanded}
				data-testid="session-folder-header"
				className={cn(
					"relative flex w-full items-center gap-1.5 rounded-lg px-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground",
					compact ? SIDEBAR_COMPACT_ROW : "py-1.5 transition-colors",
					onMenu && "pointer-coarse:pr-11",
					dropActive && "bg-accent text-foreground ring-1 ring-ring",
				)}
			>
				<ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
				<FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size) text-foreground">{folder.name}</span>
				<span data-testid="session-folder-count" className="shrink-0 pr-1 font-mono text-xs tabular-nums text-muted-foreground-70 group-hover:opacity-0 pointer-coarse:group-hover:opacity-100">
					{count}
				</span>
			</button>
			{onMenu && (
				<button
					type="button"
					aria-label={`Folder actions: ${folder.name}`}
					data-testid="session-folder-menu"
					onClick={onMenu}
					className={cn(
						"absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:bg-accent group-hover:opacity-100 pointer-coarse:opacity-100",
						compact ? "size-7 pointer-coarse:size-9" : "size-8 transition-opacity pointer-coarse:size-10",
					)}
				>
					<MoreHorizontalIcon className="size-4" />
				</button>
			)}
		</div>
	);
}

/** Drag state the list renders: which session is in flight and what it hovers. */
export interface ListDrag {
	chatId: string;
	/** The dragged session sits in a folder (so the unfiled area accepts it). */
	filed: boolean;
	/** The hovered target: a folder id, "unfiled", or null. */
	over: string | null;
}

/**
 * The session list body (session folders, owner design 2026-11-24): folders
 * first (each folds, shows its count, empty ones included), then the
 * unfiled sessions. Pure of its props, so a render test pins the layout;
 * SessionsSidebar owns the data, the menus and the requests.
 */
export function SessionList({
	grouped,
	query,
	compact = false,
	pathname,
	kbdIndex,
	renamingId,
	renamingFolderId,
	creatingFolder,
	folderNameError = null,
	drag = null,
	draggable = false,
	on,
}: {
	grouped: GroupedSessions;
	query: string;
	compact?: boolean;
	pathname: string;
	kbdIndex: number | null;
	renamingId: string | null;
	renamingFolderId: string | null;
	creatingFolder: boolean;
	/** A refused folder name: the open name row shows it and stays open. */
	folderNameError?: string | null;
	drag?: ListDrag | null;
	/** Fine pointer: rows drag onto folder headers and the unfiled area. */
	draggable?: boolean;
	on: {
		open: (chat: ChatListItem) => void;
		rowMenu: (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => void;
		rowContext: (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => void;
		commitRename: (id: string, next: string) => void;
		cancelRename: () => void;
		toggleFolder: (id: string) => void;
		folderMenu: (e: React.MouseEvent<HTMLButtonElement>, folder: SessionFolder) => void;
		folderContext: (e: React.MouseEvent<HTMLButtonElement>, folder: SessionFolder) => void;
		commitFolderName: (id: string | null, next: string) => void;
		cancelFolderName: () => void;
		dragStart?: (chat: ChatListItem, filed: boolean) => void;
		dragEnd?: () => void;
		dragOver?: (target: string | null) => void;
		drop?: (folderId: string | null) => void;
	};
}) {
	const visibleIndex = new Map(grouped.visible.map((c, i) => [c.id, i]));
	const filedIds = new Set(grouped.folders.flatMap((g) => g.chats.map((c) => c.id)));
	const row = (c: ChatListItem) => {
		if (renamingId === c.id) {
			return <RenameRow key={c.id} chat={c} compact={compact} onCommit={(next) => on.commitRename(c.id, next)} onCancel={on.cancelRename} />;
		}
		const sessionRow = (
			<SessionRow
				chat={c}
				compact={compact}
				active={pathname === `/chat/${c.id}`}
				kbdSelected={kbdIndex !== null && visibleIndex.get(c.id) === kbdIndex}
				onOpen={() => on.open(c)}
				onContextMenu={(e) => on.rowContext(e, c)}
				onMenu={(e) => on.rowMenu(e, c)}
			/>
		);
		if (!draggable) return <div key={c.id}>{sessionRow}</div>;
		return (
			<div
				key={c.id}
				draggable
				data-testid="session-drag"
				onDragStart={(e) => {
					e.dataTransfer.effectAllowed = "move";
					e.dataTransfer.setData("text/plain", c.title);
					on.dragStart?.(c, filedIds.has(c.id));
				}}
				onDragEnd={() => on.dragEnd?.()}
				className={cn(drag?.chatId === c.id && "opacity-50")}
			>
				{sessionRow}
			</div>
		);
	};
	const dropZone = (target: string | null): React.HTMLAttributes<HTMLDivElement> | undefined =>
		draggable && drag
			? {
					onDragOver: (e) => {
						e.preventDefault();
						e.dataTransfer.dropEffect = "move";
						if (drag.over !== (target ?? "unfiled")) on.dragOver?.(target ?? "unfiled");
					},
					onDragLeave: (e) => {
						if (!e.currentTarget.contains(e.relatedTarget as Node | null)) on.dragOver?.(null);
					},
					onDrop: (e) => {
						e.preventDefault();
						on.drop?.(target);
					},
				}
			: undefined;
	const searching = query.trim() !== "";
	const showUnfiledZone = !!drag?.filed;
	return (
		<>
			{creatingFolder && <FolderNameRow initial="" label="New folder name" error={folderNameError} compact={compact} onCommit={(next) => on.commitFolderName(null, next)} onCancel={on.cancelFolderName} />}
			{grouped.folders.map((g) => (
				<div key={g.folder.id} data-testid="session-folder" className="mb-0.5">
					{renamingFolderId === g.folder.id ? (
						<FolderNameRow initial={g.folder.name} label="Rename folder" error={folderNameError} compact={compact} onCommit={(next) => on.commitFolderName(g.folder.id, next)} onCancel={on.cancelFolderName} />
					) : (
						<FolderHeader
							folder={g.folder}
							count={g.chats.length}
							expanded={g.expanded}
							compact={compact}
							dropActive={drag?.over === g.folder.id}
							onToggle={() => on.toggleFolder(g.folder.id)}
							onMenu={(e) => on.folderMenu(e, g.folder)}
							onContextMenu={(e) => on.folderContext(e, g.folder)}
							dropHandlers={dropZone(g.folder.id)}
						/>
					)}
					{g.expanded && (
						<div data-testid="session-folder-body" className="ml-3.5 border-l border-border/60 pl-1.5">
							{g.chats.length === 0 ? (
								<div className={cn("px-3 text-xs text-muted-foreground-70", compact ? "py-1" : "py-1.5")}>Empty</div>
							) : (
								g.chats.map(row)
							)}
						</div>
					)}
				</div>
			))}
			{grouped.folders.length > 0 && grouped.unfiled.length > 0 && <div className="mx-2 my-1.5 border-t border-border/60" aria-hidden="true" />}
			<div
				data-testid="session-unfiled"
				{...dropZone(null)}
				className={cn(
					"rounded-lg",
					showUnfiledZone && "min-h-12 border border-dashed border-border",
					showUnfiledZone && drag?.over === "unfiled" && "border-ring bg-accent/60",
				)}
			>
				{showUnfiledZone && <div className="px-3 py-1.5 text-xs text-muted-foreground">Drop here to take it out of its folder</div>}
				{grouped.unfiled.map(row)}
			</div>
			{grouped.visible.length === 0 && grouped.folders.every((g) => g.chats.length === 0) && (
				<div className="px-2 py-4 text-xs text-muted-foreground">{searching ? "No sessions match." : "No sessions yet."}</div>
			)}
		</>
	);
}

/** The session menu's second view: every folder (the current one checked
 *  and inert), "New folder…" (files the session in it once made) and
 *  "Remove from folder" when it is filed. One panel, so it works on phones. */
export function MoveToFolderMenu({
	folders,
	current,
	onBack,
	onPick,
	onNewFolder,
}: {
	folders: readonly SessionFolder[];
	current: string | null;
	onBack: () => void;
	onPick: (folderId: string | null) => void;
	onNewFolder: () => void;
}) {
	const item = "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent pointer-coarse:min-h-10";
	return (
		<div data-testid="ctx-move-menu" className="flex flex-col gap-0.5">
			<button type="button" data-testid="ctx-move-back" onClick={onBack} className={cn(item, "text-muted-foreground hover:text-foreground")}>
				<ChevronLeftIcon className="size-3.5" aria-hidden="true" />
				Move to folder
			</button>
			<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
			<div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
				{folders.map((f) => (
					<button
						key={f.id}
						type="button"
						data-testid="ctx-move-folder"
						disabled={f.id === current}
						aria-current={f.id === current ? "true" : undefined}
						onClick={() => onPick(f.id)}
						className={cn(item, "text-foreground disabled:hover:bg-transparent")}
					>
						{f.id === current ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
						<span className="min-w-0 flex-1 truncate font-prose">{f.name}</span>
					</button>
				))}
			</div>
			<button type="button" data-testid="ctx-move-new" onClick={onNewFolder} className={cn(item, "text-foreground")}>
				<FolderPlusIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				New folder…
			</button>
			{current !== null && (
				<button type="button" data-testid="ctx-move-remove" onClick={() => onPick(null)} className={cn(item, "text-muted-foreground-80 hover:text-foreground")}>
					Remove from folder
				</button>
			)}
		</div>
	);
}

/** Folded folders, per device (owner design): a JSON id list in
 *  localStorage. Every access is guarded; storage off means all open. */
const COLLAPSED_FOLDERS_KEY = "lh:session-folders-collapsed";
export function readCollapsedFolders(): Set<string> {
	try {
		const raw = window.localStorage.getItem(COLLAPSED_FOLDERS_KEY);
		const ids: unknown = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}
function writeCollapsedFolders(ids: ReadonlySet<string>): void {
	try {
		window.localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...ids]));
	} catch {
		// storage off: the fold lasts for this page only
	}
}

const FINE_QUERY = "(pointer: fine)";
/** Drag and drop is for a fine pointer only (desktop); phones move through the menu. */
function useFinePointer(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const mq = window.matchMedia(FINE_QUERY);
			mq.addEventListener("change", onChange);
			return () => mq.removeEventListener("change", onChange);
		},
		() => window.matchMedia(FINE_QUERY).matches,
		() => false,
	);
}

/** The three-way kind filter (practice sessions, owner 2026-10-04):
 *  Teaching / All / Practice — a client-side filter over the same
 *  snapshot, persisted in localStorage, defaulting to All. */
export type { SessionKindFilter } from "@/src/core";
const KIND_FILTER_KEY = "lh:session-kind-filter";

function SessionsSidebar() {
	const { appearance: { compactSessionList } } = useAppearance();
	const { open, toggle, narrow, setOpen } = useSidebar();
	const backdropDismiss = useBackdropDismiss(() => setOpen(false));
	// Phone drawer only: the back gesture closes it instead of leaving the page.
	useBackDismiss(narrow && open, () => setOpen(false));
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<SessionKindFilter>("all");
	useEffect(() => {
		const stored = window.localStorage.getItem(KIND_FILTER_KEY);
		if (stored === "teach" || stored === "all" || stored === "practice") setKindFilter(stored);
	}, []);
	const setFilter = useCallback((f: SessionKindFilter) => {
		setKindFilter(f);
		window.localStorage.setItem(KIND_FILTER_KEY, f);
	}, []);
	const pathname = usePathname();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();

	/* New session (owner, 2026-09-13): NO POST — the button opens the
	   sessionless draft view; the session is created only when the first
	   message is sent (and that message becomes its title). Search: a
	   client-side filter over the poll snapshot — no server round trip. */
	const newSession = useCallback(() => {
		router.push("/chat/new");
	}, [router]);

	/* FUZZY (owner round 8, 2026-10-05): subsequence match ranked by
	 * fuzzyScore — prefix beats word-boundary beats scattered. Empty query
	 * keeps the natural list order. Session folders (2026-11-24): the list is
	 * grouped (core groupSessions) — folders first, then the unfiled rows;
	 * `visible` is the screen order the search walk indexes. */
	const [folders, setFolders] = useState<SessionFoldersView | null>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => setCollapsed(readCollapsedFolders()), []);
	const grouped = useMemo(
		() => (chats ? groupSessions(chats, folders, { kind: kindFilter, query, collapsed }) : null),
		[chats, folders, kindFilter, query, collapsed],
	);
	const shown = grouped?.visible ?? null;

	const refreshInFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		// In-flight coalesce (S6): event bursts may land several refresh
		// calls at once — one fetch serves them all; anything newer arrives
		// with the next event's fetch.
		if (refreshInFlightRef.current) return;
		refreshInFlightRef.current = true;
		try {
			const [res, folderRes] = await Promise.all([
				fetch("/api/chats", { cache: "no-store" }),
				fetch("/api/session-folders", { cache: "no-store" }).catch(() => null),
			]);
			const d = await okJson<{ chats: ChatListItem[] }>(res);
			setChats(d.chats);
			// Folders are best effort: a failed read keeps the last view (the
			// list still shows every session, unfiled).
			if (folderRes?.ok) setFolders((await folderRes.json()) as SessionFoldersView);
		} catch {
			// a transient failure keeps the last snapshot
			setChats((prev) => prev ?? []);
		} finally {
			refreshInFlightRef.current = false;
		}
	}, []);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch lh:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts lh:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("lh:turn-state", onTurnState);
		return () => window.removeEventListener("lh:turn-state", onTurnState);
	}, [refresh]);

	/* PUSH (architecture S6, 2026-10-02): the 2.5s poll is RETIRED — the
	   last standing network poll in the app. List truth arrives as
	   events: chats-changed (create/rename/delete — the list-SHAPE
	   writes), and turn-started/turn-settled for EVERY chat (unfiltered:
	   any chat's turn flips busy/order/phase in this list). Announced
	   fetches ride the 250ms trailing debounce (the S4/S5 law); resync
	   (reconnect / dev-restart) is immediate. lh:turn-state +
	   lh:chat-renamed stay for same-tab INSTANTS — local beats any
	   round-trip. */
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const eventDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleEventRefresh = () => {
		if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		eventDebounceRef.current = setTimeout(() => {
			eventDebounceRef.current = undefined;
			void refreshRef.current();
		}, 250);
	};
	useServerEvent("chats-changed", scheduleEventRefresh);
	useServerEvent("folders-changed", scheduleEventRefresh);
	useServerEvent("turn-started", scheduleEventRefresh);
	useServerEvent("turn-settled", scheduleEventRefresh);
	useServerEvent("compaction-changed", scheduleEventRefresh);
	useServerResync(() => void refreshRef.current());
	useEffect(
		() => () => {
			if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		},
		[],
	);

	/* ── Keyboard seams (shortcut wave A, 2026-09-17; search-walk round
	   2026-10-10) ── ⌘⇧F focuses the search field — and THE SEARCH OWNS THE
	   WALK: ↑/↓ cycle the filtered list (wrap — "cycle"), Enter opens the
	   walked row, or the FIRST match when nothing is walked (owner,
	   2026-10-10 — the quick-open pattern: ⌘⇧F, type, Enter, done). The
	   Alt+↑/↓/↵ global cycle was RETIRED the same round: barely used,
	   felt laggy. The selection is a row index into `shown`, so the walk
	   follows whatever the query + kind filter leave. Mouse and keyboard
	   coexist: hovering doesn't claim, a click or an open clears the
	   selection. */
	const [kbdIndex, setKbdIndex] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	/* ── Wave 6 chunk A: context menu + inline rename + deletion ──
	   Right-click a session row → MenuShell: the two management actions
	   first (owner ruling), then — below a hairline — the extraction
	   coverage block (owner-locked redesign 2026-09-24, order refined
	   2026-09-24: Rename/Delete on top, the numbers + manual Extract
	   affordance at the bottom). The anchor is the row that was
	   right-clicked — assigned into a ref before the state flip so the
	   shell measures it on its first (hidden) pass. */
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);

	/* ── Session folders (owner design 2026-11-24) ── the session menu gains
	   a "Move to folder" view (folders, New folder…, Remove from folder), a
	   folder header has its own menu (Rename, Delete…), and on a fine
	   pointer a row drags onto a folder header or the unfiled area. Every
	   write answers with the fresh view, which the list adopts at once. */
	const [ctxView, setCtxView] = useState<"main" | "move">("main");
	const [folderCtx, setFolderCtx] = useState<SessionFolder | null>(null);
	const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
	/** The inline new-folder row: open, and the session to file in it once made. */
	const [creatingFolder, setCreatingFolder] = useState<{ forChat: string | null } | null>(null);
	const [deletingFolder, setDeletingFolder] = useState<SessionFolder | null>(null);
	const [drag, setDrag] = useState<ListDrag | null>(null);
	const finePointer = useFinePointer();

	const toggleFolder = useCallback(
		(id: string) => {
			if (query.trim()) return; // a search shows matching folders open; folding waits for it to clear
			setCollapsed((prev) => {
				const next = new Set(prev);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				writeCollapsedFolders(next);
				return next;
			});
		},
		[query],
	);

	/** One folder write: adopt the answered view; on failure refetch the truth. */
	const folderWrite = useCallback(
		async (url: string, method: string, body?: unknown): Promise<{ folder?: SessionFolder; error?: string } | null> => {
			try {
				const res = await fetch(url, {
					method,
					...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
				});
				const d = (await res.json()) as SessionFoldersView & { folder?: SessionFolder; error?: string };
				if (res.status === 409 && d.error === "duplicate_name") return { error: d.error }; // the name row says so
				if (!res.ok) throw new Error(d.error ?? `folder write failed: ${res.status}`);
				setFolders({ folders: d.folders, assignments: d.assignments });
				return d;
			} catch (err) {
				console.error("folder write failed:", err);
				void refresh();
				return null;
			}
		},
		[refresh],
	);

	const moveChat = useCallback(
		(chatId: string, folderId: string | null) => {
			// Optimistic: the row moves now, the answer confirms it.
			setFolders((prev) => {
				if (!prev) return prev;
				const assignments = { ...prev.assignments };
				if (folderId === null) delete assignments[chatId];
				else assignments[chatId] = folderId;
				return { ...prev, assignments };
			});
			void folderWrite(`/api/chats/${chatId}/folder`, "PUT", { folderId });
		},
		[folderWrite],
	);

	/** A refused name keeps its row open with this line (duplicate names are refused). */
	const [folderNameError, setFolderNameError] = useState<string | null>(null);
	const closeFolderName = useCallback(() => {
		setRenamingFolderId(null);
		setCreatingFolder(null);
		setFolderNameError(null);
	}, []);
	const commitFolderName = useCallback(
		async (id: string | null, next: string) => {
			const forChat = creatingFolder?.forChat ?? null;
			const name = normalizeFolderName(next);
			// Empty discards, like the session rename; so does an unchanged name.
			if (name === null || (id !== null && folders?.folders.find((f) => f.id === id)?.name === name)) {
				closeFolderName();
				return;
			}
			const out = id !== null ? await folderWrite(`/api/session-folders/${id}`, "PATCH", { name }) : await folderWrite("/api/session-folders", "POST", { name });
			if (out?.error === "duplicate_name") {
				setFolderNameError(`A folder named “${name}” already exists.`);
				return;
			}
			closeFolderName();
			if (id === null && out?.folder && forChat) moveChat(forChat, out.folder.id);
		},
		[creatingFolder, folders, folderWrite, moveChat, closeFolderName],
	);

	const openContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setFolderCtx(null);
		setCtxView("main");
		setCtxChatId(chat.id);
	};
	// The row's "⋯": same menu, anchored to the button; a second tap closes.
	const toggleContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		if (ctxChatId === chat.id && ctxAnchorRef.current === e.currentTarget) {
			setCtxChatId(null);
			return;
		}
		openContext(e, chat);
	};

	// The menu contract (agent-section's): any pointerdown outside the menu
	// or its row closes it; Esc is CLAIMED so it never also aborts a turn
	// or folds the sidebar. Right-clicking another row re-anchors: its
	// pointerdown closes this menu, its contextmenu opens the next.
	const menuOpen = ctxChatId !== null || folderCtx !== null;
	const closeMenus = useCallback(() => {
		setCtxChatId(null);
		setFolderCtx(null);
		setCtxView("main");
	}, []);
	useEffect(() => {
		if (!menuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			closeMenus();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				closeMenus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen, closeMenus]);

	const openFolderContext = (e: React.MouseEvent<HTMLButtonElement>, folder: SessionFolder) => {
		e.preventDefault();
		ctxAnchorRef.current = e.currentTarget;
		setCtxChatId(null);
		setFolderCtx(folder);
	};
	const toggleFolderContext = (e: React.MouseEvent<HTMLButtonElement>, folder: SessionFolder) => {
		if (folderCtx?.id === folder.id && ctxAnchorRef.current === e.currentTarget) {
			setFolderCtx(null);
			return;
		}
		openFolderContext(e, folder);
	};

	// Inline rename (owner ruling, wave 6): the row swaps to a text input;
	// commit rides the SAME plumbing as the header rename — PUT the title,
	// then lh:chat-renamed patches every listener (this sidebar's own
	// listener patches the snapshot instantly; an open chat header hears
	// it too). Esc discards; empty commit discards (the header's rules).
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const t = next.trim();
		if (t === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);

	// Delete success: patch the list instantly (the poll is the backstop),
	// navigate home if the open session died (the chat view unmounts —
	// drafts die with it, no orphan bubbles), and announce the graph
	// revision so the graph view refetches (deletion is the one writer
	// the status poll can't see — no run ever transitions some→none).
	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
		},
		[pathname, router],
	);

	useEffect(() => {
		const onFocusSearch = () => {
			if (!open) toggle();
			// A clipped (overflow-hidden) input still focuses — the sidebar's
			// slide-in doesn't gate the keystroke.
			requestAnimationFrame(() => searchRef.current?.focus());
		};
		window.addEventListener("lh:kbd-sessions-search", onFocusSearch);
		return () => window.removeEventListener("lh:kbd-sessions-search", onFocusSearch);
	}, [open, toggle]);

	// Keep the kbd-selected row in view (the row buttons, in list order, so
	// the index matches; the "⋯" buttons carry another testid).
	useEffect(() => {
		if (kbdIndex === null) return;
		listRef.current?.querySelectorAll('button[data-testid^="session-row"]')[kbdIndex]?.scrollIntoView({ block: "nearest" });
	}, [kbdIndex]);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// Opening + navigation refetch; while open, the events channel owns
		// freshness (S6) — no interval, nothing standing.
	}, [open, pathname, refresh]);

	return (
		<>
		{/* Phones: the dim backdrop behind the drawer — a tap on it closes. */}
		{narrow && open && (
			<div className="fixed inset-0 z-40 bg-background/80 md:hidden" data-testid="sidebar-backdrop" {...backdropDismiss} />
		)}
		<aside
			className={cn(
				"sidebar-motion overflow-hidden duration-200",
				// Below md: a fixed slide-in drawer. md and up: the inline push panel.
				"fixed inset-y-0 left-0 z-50 w-[85vw] max-w-72 md:static md:z-auto md:max-w-none md:shrink-0 md:translate-x-0",
				open ? "translate-x-0 md:w-72" : "-translate-x-full md:w-0",
			)}
			aria-hidden={!open}
			inert={narrow && !open}
			data-testid="sidebar"
		>
			<div className="flex h-full w-full flex-col border-r bg-background max-md:pb-safe max-md:pl-safe max-md:pt-safe md:w-72">
				{/* LH wordmark — the owner's header; close toggle sits at the edge. */}
				<div className="flex items-center justify-between px-4 py-3">
					{/* The owner's mark (2026-09-17) replaces the "LH" text — still the
					    home link, still vertically centered by the band's items-center. */}
					{/* Hover mirrors the ghost toggle buttons (owner ask, 2026-09-17):
					    same size-9 chip geometry, same hover:bg-accent treatment. */}
					<Hint
						// Kept (owner, subtlety round 2026-09-25) but to the RIGHT
						// of the logo, carrying its real shortcut: ⌘G jumps to
						// the graph view (keyboard-shortcuts routes it to "/",
						// the same destination as this logo).
						label="Home"
						action="jump-graph"
						side="right"
					>
						<Link
							href="/"
							aria-label="Home"
							className="flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
						>
							<LhMark className="size-6" />
						</Link>
					</Hint>
					<Hint label="Close sidebar" action="toggle-sidebar">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close sidebar"
							onClick={toggle}
						>
							<PanelLeftCloseIcon className="size-4" />
						</Button>
					</Hint>
				</div>

				{/* Two doors, STACKED (owner round 8, 2026-10-05 — was a
				    half/half row): full-width rows read cleaner and give the
				    labels room; teaching keeps the original draft route,
				    practice carries its mode. */}
				<div className="mx-3 mb-2 flex flex-col gap-1.5">
					<button
						type="button"
						data-testid="new-session"
						onClick={() => void newSession()}
						className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3" />
						Teaching
						<span className="sr-only">create a new teaching session</span>
					</button>
					<button
						type="button"
						data-testid="new-session-practice"
						onClick={() => router.push("/chat/new?mode=practice")}
						className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DumbbellIcon className="size-3" />
						Practice
						<span className="sr-only">create a new practice session</span>
					</button>
				</div>

				<div className="mx-3 mb-2 flex items-center gap-2">
					<span className="text-xs uppercase tracking-widest text-muted-foreground-70">Sessions</span>
					<Hint label="Search sessions" action="sessions-search" side="bottom">
					<span className="relative flex-1">
						<Input
							ref={searchRef}
							data-testid="session-search"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								// The list reorders under the query every keystroke —
								// a stale walk index would point at the wrong row.
								setKbdIndex(null);
							}}
							// THE SEARCH OWNS THE WALK (owner, 2026-10-10 — the
							// retired Alt+↑/↓/↵ cycle's successor): ↑/↓ cycle the
							// filtered rows (wrap), Enter opens the walked row —
							// or the FIRST match when nothing is walked (the
							// quick-open pattern) — then blurs (focus returns to
							// the app per the Enter law; the query stays for
							// re-searching). Esc leaves the search (owner,
							// keyboard wave): blur back to normal, and claim the
							// key so the window Esc chain (dictation / abort)
							// doesn't also fire.
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									e.currentTarget.blur();
									return;
								}
								// Modified keys belong to the surface (⇧↵ etc.).
								if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
								const n = shown?.length ?? 0;
								if (n === 0) return;
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									// The rows move, not the caret.
									e.preventDefault();
									const dir = e.key === "ArrowDown" ? 1 : -1;
									setKbdIndex((i) =>
										i === null || i >= n ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n,
										);
									return;
								}
								if (e.key === "Enter") {
									const target = shown![kbdIndex !== null && kbdIndex < n ? kbdIndex : 0];
									if (!target) return;
									e.preventDefault();
									router.push(`/chat/${target.id}`);
									setKbdIndex(null);
									e.currentTarget.blur();
								}
							}}
							placeholder="Search…"
							aria-label="Search sessions"
							className="h-6 rounded-sm border-border bg-background pl-6 text-xs placeholder:text-muted-foreground-60 pointer-coarse:h-9 pointer-coarse:pl-8"
						/>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 pointer-coarse:left-2.5 size-3 -translate-y-1/2 text-muted-foreground-70" />
					</span>
					</Hint>
					<Hint label="New folder" side="bottom">
						<button
							type="button"
							aria-label="New folder"
							data-testid="new-folder"
							disabled={!folders}
							onClick={() => {
								setRenamingFolderId(null);
								setFolderNameError(null);
								setCreatingFolder({ forChat: null });
							}}
							className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 pointer-coarse:size-9"
						>
							<FolderPlusIcon className="size-3.5" />
						</button>
					</Hint>
				</div>

				{/* The three-way filter, HEADING THE LIST (owner round 8b,
				    2026-10-05 — moved below the search): it scopes what the
				    list shows, so it sits directly above it as a caption row;
				    search stays the top muscle-memory target. Order: Teaching /
				    Practice / All — the real modes first, "All" as the escape
				    hatch on the right, mirroring the create-buttons above.
				    Persisted client-side. */}
				<div className="mx-3 flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="session-kind-filter">
					{(["teach", "practice", "all"] as const).map((f) => (
						<button
							key={f}
							type="button"
							data-testid={`kind-filter-${f}`}
							onClick={() => setFilter(f)}
							className={cn(
								"flex-1 rounded-sm px-2 py-1 text-[11px] uppercase tracking-wider transition-colors pointer-coarse:min-h-9",
								kindFilter === f
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{f === "teach" ? "Teaching" : f === "all" ? "All" : "Practice"}
						</button>
					))}
				</div>

				<div ref={listRef} className="flex-1 overflow-y-auto p-2">
					{grouped === null ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
					) : (
						<SessionList
							grouped={grouped}
							query={query}
							compact={compactSessionList}
							pathname={pathname}
							kbdIndex={kbdIndex}
							renamingId={renamingId}
							renamingFolderId={renamingFolderId}
							creatingFolder={creatingFolder !== null}
							folderNameError={folderNameError}
							draggable={finePointer && !!folders}
							drag={drag}
							on={{
								open: (c) => {
									setKbdIndex(null);
									router.push(`/chat/${c.id}`);
								},
								rowMenu: toggleContext,
								rowContext: openContext,
								commitRename: (id, next) => void commitRename(id, next),
								cancelRename: () => setRenamingId(null),
								toggleFolder,
								folderMenu: toggleFolderContext,
								folderContext: openFolderContext,
								commitFolderName: (id, next) => void commitFolderName(id, next),
								cancelFolderName: closeFolderName,
								dragStart: (c, filed) => setDrag({ chatId: c.id, filed, over: null }),
								dragEnd: () => setDrag(null),
								dragOver: (over) => setDrag((d) => (d ? { ...d, over } : d)),
								drop: (folderId) => {
									const d = drag;
									setDrag(null);
									if (!d || (folders?.assignments[d.chatId] ?? null) === folderId) return;
									moveChat(d.chatId, folderId);
								},
							}}
						/>
					)}
				</div>

					{/* Background agents (owner, sidebar round): the section is
					    ALWAYS here — empty means empty (the header sits alone); it
					    populates and grows when processes run. The session list is
					    flex-1, so this pins to the bottom. Sidebar closed = the
					    learner opted out (no ambient signal, user decision). */}
					<ActivitySection />

					{/* Settings entry (settings-app wave): same row language as
					    New session — quiet, bottom-pinned, opens the centered
					    dialog (also mod+, in the keyboard registry). */}
					<div className="flex flex-col items-start px-3 pb-3 pt-1">
						<SidebarLibraryLinks pathname={pathname} />
						<Hint label="Settings" action="open-settings" side="right">
							<button
								type="button"
								onClick={() => openSettings()}
								data-testid="settings-entry"
								className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<SettingsIcon className="size-3" />
								Settings
							</button>
						</Hint>
						<AccountLine />
					</div>
				</div>

				{/* The context menu (wave 6 + the extraction-UX redesign): the
				    coverage block above, then exactly two management actions
				    (owner ruling — no more). MenuShell owns placement/focus/arrow
				    cycling; the dismissal effect above owns the contract. */}
				{ctxChatId !== null && (
					<MenuShell
						anchorRef={ctxAnchorRef}
						testid="session-context-menu"
						preferredSide="down"
						menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						{/* The two management actions first, then the extraction block
						    (owner refinement round, 2026-09-24): Rename/Delete stay at the
						    top, the coverage numbers + Extract affordance sit below the
						    hairline — the block is info + a stateful affordance, the
						    actions above it. Fetched on menu open (the block mounts WITH
						    the menu); 409 = benign. Renders nothing on a failed read. */}
						{ctxView === "move" && folders ? (
							<MoveToFolderMenu
								folders={folders.folders}
								current={folders.assignments[ctxChatId] ?? null}
								onBack={() => setCtxView("main")}
								onPick={(folderId) => {
									const chatId = ctxChatId;
									closeMenus();
									moveChat(chatId, folderId);
								}}
								onNewFolder={() => {
									const chatId = ctxChatId;
									closeMenus();
									setRenamingFolderId(null);
									setFolderNameError(null);
									setCreatingFolder({ forChat: chatId });
								}}
							/>
						) : (
							<>
						<button
							type="button"
							data-testid="ctx-rename"
							onClick={() => {
								setRenamingId(ctxChatId);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						{folders && (
							<button
								type="button"
								data-testid="ctx-move"
								onClick={() => setCtxView("move")}
								className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
							>
								Move to folder
								<ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
							</button>
						)}
						{/* Export as Markdown (owner, release polish 2026-10-06): the
					    session-markdown engine's user-facing debut — same-origin
						    anchor download; the route's Content-Disposition names the
						    file. Sits with the management actions, above Delete (the
						    destructive action stays last — the danger-fence law). */}
						<button
							type="button"
							data-testid="ctx-export-md"
							onClick={() => {
								const chatId = ctxChatId;
								setCtxChatId(null);
								const a = document.createElement("a");
								a.href = `/api/chats/${chatId}/markdown`;
								a.download = ""; // the route's filename wins
								document.body.appendChild(a);
								a.click();
								a.remove();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Export as Markdown…
						</button>
						<button
							type="button"
							data-testid="ctx-delete"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) setDeleting(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground-80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete…
						</button>
						<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
						<CoverageMenuBlock chatId={ctxChatId} />
							</>
						)}
					</MenuShell>
				)}

				{/* The two-option delete dialog (wave 6) — portaled to body
				    by the component itself, lives here for state locality. */}
				<DeleteSessionDialog
					chat={deleting}
					onClose={() => setDeleting(null)}
					onDeleted={onDeleted}
				/>

				{/* The folder menu: Rename (inline, like a session) and Delete…. */}
				{folderCtx !== null && (
					<MenuShell
						anchorRef={ctxAnchorRef}
						testid="folder-context-menu"
						preferredSide="down"
						menuClass="flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						<button
							type="button"
							data-testid="folder-ctx-rename"
							onClick={() => {
								setCreatingFolder(null);
								setFolderNameError(null);
								setRenamingFolderId(folderCtx.id);
								closeMenus();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						<button
							type="button"
							data-testid="folder-ctx-delete"
							onClick={() => {
								setDeletingFolder(folderCtx);
								closeMenus();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground-80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete…
						</button>
					</MenuShell>
				)}
				<DeleteFolderDialog
					folder={deletingFolder}
					sessionCount={deletingFolder && chats && folders ? chats.filter((c) => folders.assignments[c.id] === deletingFolder.id).length : 0}
					onClose={() => setDeletingFolder(null)}
					onDeleted={(view) => {
						setDeletingFolder(null);
						setFolders(view as SessionFoldersView);
					}}
				/>
			</aside>
		</>
	);
}

/** The two library entries above Settings: the document library (PR G: imported notes and
 *  scanned PDFs) and "My knowledge" (/knowledge: what the learner has shown, as a graph and
 *  an overview). Same row style; the current page reads as foreground. Pure of its props. */
export function SidebarLibraryLinks({ pathname }: { pathname: string }) {
	const row = (active: boolean) =>
		cn(
			"flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground",
			active ? "text-foreground" : "text-muted-foreground",
		);
	const onDocuments = pathname === "/documents" || pathname.startsWith("/documents/");
	const onKnowledge = pathname === "/knowledge";
	return (
		<>
			<Link href="/documents" data-testid="documents-entry" aria-current={onDocuments ? "page" : undefined} className={row(onDocuments)}>
				<LibraryIcon className="size-3" />
				Documents
			</Link>
			<Link href="/knowledge" data-testid="knowledge-entry" aria-current={onKnowledge ? "page" : undefined} className={row(onKnowledge)}>
				<BrainIcon className="size-3" />
				My knowledge
			</Link>
		</>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	// Publishes --vvh while the phone keyboard is up: the page roots (chat,
	// new session, home) are h-full of <main>, so one height follows the
	// visible viewport and the composer stays above the keyboard.
	useVisualViewport();
	return (
		<SettingsDialogProvider>
			<SessionsSidebar />
			<main className="min-w-0 flex-1 max-md:h-[var(--vvh,auto)] max-md:pb-[var(--lh-tabbar-h,0px)] max-md:[&>div]:h-full">{children}</main>
			<BottomTabs />
			{/* The single document-level keydown listener (keyboard wave A) —
			    after the content in the tree, but it's window-level so order only
			    matters for the events it dispatches, never for DOM priority. */}
			<KeyboardShortcuts />
		</SettingsDialogProvider>
	);
}
