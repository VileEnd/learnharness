import { Home } from "@/components/home";
import { modelsConfigured, readSettingsRecord, withPageTenant } from "@/src/server";
import { resolveSettings } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

export default async function HomePage() {
	return withPageTenant(() => {
	// First-run gate (model-slots wave): chats cannot start until the user
	// has picked all three slots — the dock shows the CTA while the raw
	// record's models section lacks any slot pin (a restricted user: only
	// the slots their policy defines, modelsConfigured).
	const record = readSettingsRecord();
	// GRAPH RENDERING (owner, 2026-10-06): off = the home's main view is
	// the chains view. Resolved through the one core resolver (missing
	// section / absent key → factory default on); re-read per navigation.
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return (
		<Home initialConfigured={modelsConfigured()} rendering={rendering} />
	);
	});
}
