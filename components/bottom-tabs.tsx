"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ListIcon, NetworkIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useSidebar } from "@/components/sidebar";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { isKeyboardOpen } from "@/components/sidebar-state";
import { cn } from "@/lib/utils";

/**
 * The phone's bottom tab bar (below `md` only): Graph · Sessions · New ·
 * Settings, each at least 44px tall. Sessions opens the sidebar drawer.
 * It hides while the on-screen keyboard is up, and publishes its height as
 * `--lh-tabbar-h` on <html> (0 when hidden or on md+) so the app frame can
 * pad above it and bottom-docked composers lift with it.
 */
export function BottomTabs() {
	const pathname = usePathname();
	const router = useRouter();
	const { open: drawerOpen, setOpen: setDrawer } = useSidebar();
	const { open: openSettings } = useSettingsDialog();
	const [keyboard, setKeyboard] = useState(false);
	const barRef = useRef<HTMLElement>(null);

	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const coarse = window.matchMedia("(pointer: coarse)");
		const check = () => setKeyboard(isKeyboardOpen(vv.height, window.innerHeight, coarse.matches));
		check();
		vv.addEventListener("resize", check);
		return () => vv.removeEventListener("resize", check);
	}, []);

	// A display:none bar measures 0, so one observer covers keyboard-hidden
	// and md+ alike.
	useEffect(() => {
		const el = barRef.current;
		if (!el) return;
		const root = document.documentElement;
		const publish = () => root.style.setProperty("--lh-tabbar-h", `${el.offsetHeight}px`);
		publish();
		const ro = new ResizeObserver(publish);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.setProperty("--lh-tabbar-h", "0px");
		};
	}, []);

	return (
		<nav
			ref={barRef}
			aria-label="Primary"
			data-testid="bottom-tabs"
			className={cn(
				"fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-background pb-safe md:hidden",
				keyboard && "hidden",
			)}
		>
			<Tab label="Graph" active={pathname === "/"} onClick={() => router.push("/")} testid="tab-graph">
				<NetworkIcon className="size-5" />
			</Tab>
			<Tab label="Sessions" active={drawerOpen} onClick={() => setDrawer(true)} testid="tab-sessions">
				<ListIcon className="size-5" />
			</Tab>
			<Tab label="New" active={pathname === "/chat/new"} onClick={() => router.push("/chat/new")} testid="tab-new">
				<PlusIcon className="size-5" />
			</Tab>
			<Tab label="Settings" active={false} onClick={() => openSettings()} testid="tab-settings">
				<SettingsIcon className="size-5" />
			</Tab>
		</nav>
	);
}

function Tab({
	label,
	active,
	onClick,
	testid,
	children,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	testid: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-testid={testid}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] uppercase tracking-wider transition-colors",
				active ? "text-foreground" : "text-muted-foreground",
			)}
		>
			{children}
			{label}
		</button>
	);
}
