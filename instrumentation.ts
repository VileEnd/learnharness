/**
 * Next's server-start hook (runs once per server process, before requests).
 * The refreshed model catalog: publish the saved snapshot (local file only,
 * no network), then arm the daily refresh (an unref'd timer, off in tests and
 * during `next build`). Neither may stop the server from starting.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	try {
		const { initializeModelCatalog, startModelCatalogSchedule } = await import("./src/server/remote-model-catalog.ts");
		initializeModelCatalog();
		startModelCatalogSchedule();
	} catch (err) {
		console.error("[model-catalog] startup failed; the bundled catalog stays in use:", err);
	}
}
