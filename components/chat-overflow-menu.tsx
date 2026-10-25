"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileSearchIcon, MessageSquareQuoteIcon, MoreHorizontalIcon, WaypointsIcon } from "lucide-react";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { MenuShell } from "@/components/menu-shell";
import { kbdEventForAction } from "@/src/core";

const ITEM =
	"flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent";

/**
 * The chat top bar's phone overflow ("⋯", below `sm` only): the Plan /
 * phase / coverage chips fold in here, plus the two actions that were
 * keyboard-only — Find in session (⌘F) and Toggle all my thinking (⌘T).
 * Both are the shortcut's own event, so the mounted session answers them
 * exactly as it answers the key. Desktop keeps the chips inline.
 */
export function ChatOverflowMenu({
	chatId,
	hasPlan,
	onOpenPlan,
	showCoverage,
	phase,
}: {
	chatId: string;
	hasPlan: boolean;
	onOpenPlan: () => void;
	showCoverage: boolean;
	/** The phase / Practice chip, rendered read-only at the menu's top. */
	phase: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement>(null);

	// Same contract as the sidebar row menu: a pointerdown outside closes,
	// Esc is claimed so it never also aborts a turn.
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (anchorRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const fire = (action: "find" | "toggle-user-thinking") => {
		setOpen(false);
		window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
	};

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				aria-label="More"
				aria-expanded={open}
				data-testid="chat-overflow"
				onClick={() => setOpen((v) => !v)}
				className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:hidden"
			>
				<MoreHorizontalIcon className="size-4" />
			</button>
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid="chat-overflow-menu"
					preferredSide="down"
					menuClass="flex w-60 flex-col gap-0.5 rounded-xl border bg-card p-2 text-sm shadow-xl"
				>
					<div className="flex min-h-9 items-center px-2.5">{phase}</div>
					{hasPlan && (
						<button
							type="button"
							data-testid="overflow-plan"
							onClick={() => {
								setOpen(false);
								onOpenPlan();
							}}
							className={ITEM}
						>
							<WaypointsIcon className="size-4 text-primary" aria-hidden />
							Plan
						</button>
					)}
					<button type="button" data-testid="overflow-find" onClick={() => fire("find")} className={ITEM}>
						<FileSearchIcon className="size-4 text-muted-foreground" aria-hidden />
						Find in session
					</button>
					<button
						type="button"
						data-testid="overflow-toggle-thinking"
						onClick={() => fire("toggle-user-thinking")}
						className={ITEM}
					>
						<MessageSquareQuoteIcon className="size-4 text-muted-foreground" aria-hidden />
						Toggle all my thinking
					</button>
					{showCoverage && (
						<>
							<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
							<CoverageMenuBlock chatId={chatId} />
						</>
					)}
				</MenuShell>
			)}
		</>
	);
}
