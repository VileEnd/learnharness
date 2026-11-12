import { OpenSettingsDialog } from "@/components/settings/open-settings-dialog";

/**
 * The settings surface is a centered dialog over the app (settings-app wave,
 * 2026-09-20 — owner decision: modal-only, no page). This URL stays routed
 * so the manifest's Settings shortcut has somewhere to land: it opens the
 * dialog and moves on to the new-session home. Nothing lands on a dead page.
 */
export default function SettingsPage() {
	return <OpenSettingsDialog />;
}
