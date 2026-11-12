import * as fs from "node:fs";
import * as path from "node:path";

/** The marker in src/server/pwa/sw.js that the served script replaces with the build id. */
const BUILD_ID_MARKER = "__LH_BUILD_ID__";

/** The worker with the build id embedded. The id becomes a string literal, so
 *  only id-safe characters survive. */
export function renderServiceWorker(source: string, buildId: string): string {
	return source.replace(BUILD_ID_MARKER, buildId.replace(/[^A-Za-z0-9._-]/g, ""));
}

let cached: string | undefined;

/** The script served at /sw.js. The build id is inlined by next.config.ts
 *  (`env`); the source is read once from disk (traced into the standalone
 *  output, see next.config.ts) and kept. */
export function serviceWorkerScript(): string {
	cached ??= renderServiceWorker(
		fs.readFileSync(path.join(process.cwd(), "src/server/pwa/sw.js"), "utf-8"),
		process.env.LH_BUILD_ID ?? "dev",
	);
	return cached;
}
