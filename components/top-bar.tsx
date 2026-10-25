"use client";

/**
 * THE TOP BAR (owner standardization ruling, 2026-09-29): one element,
 * every surface — the same mechanics ALWAYS. Born from the chains-overlay
 * incident: its hand-rolled bar broke every rule at once (wrong height,
 * wrong title size, no sidebar reopen). The law: whenever a surface has a
 * top bar, it renders THIS component — never a bespoke header.
 *
 * Mechanics baked in (the chat-session bar's proven pattern):
 * - h-15 (60px) — matches the sidebar's wordmark band, one border line.
 * - select-none — clicking around the bar never highlights the title.
 * - SidebarToggle FIRST — the sidebar reopen when closed.
 * - border-b border-border px-3, gap-3 rhythm.
 *
 * The consumer brings the title (font-title text-3xl tracking-tight) and
 * any right-side controls. THE TITLE LAW (owner round 11, 2026-10-05):
 * the serif title ALWAYS names a session — chrome-less creation surfaces
 * (home, both /chat/new drafts) and the chain table render NO title.
 */

import type { ReactNode } from "react";
import { SidebarToggle } from "@/components/sidebar";

export function TopBar({
	onMouseDown,
	children,
}: {
	onMouseDown?: React.MouseEventHandler<HTMLElement>;
	children?: ReactNode;
}) {
	return (
		<header
			onMouseDown={onMouseDown}
			className="flex h-15 select-none items-center gap-3 border-b border-border px-3"
		>
			<SidebarToggle />
			{children}
		</header>
	);
}
