"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";

/** The /settings URL (the manifest's Settings shortcut) opens the settings
 *  dialog over the app, then leaves the URL for the home a new session starts from. */
export function OpenSettingsDialog() {
	const { open } = useSettingsDialog();
	const router = useRouter();
	useEffect(() => {
		open();
		router.replace("/chat/new");
	}, [open, router]);
	return null;
}
