/**
 * Preload for every test process (`tsx --import ./tests/setup.ts --test ...`).
 *
 * 1. Data isolation: unless the suite's runner already chose one, every
 *    process gets its own temp LH_DATA_DIR and LH_AUTH_FILE, removed on exit,
 *    so no test reads or writes the developer's real data/ or auth.json.
 *    config.ts reads both at module load, so this runs before any suite
 *    code; suites that set their own LH_DATA_DIR before their first config
 *    import simply override it.
 * 2. Network guard: globalThis.fetch refuses every non-loopback host. Tests
 *    that stub fetch replace this wrapper (and restore it); loopback passes
 *    through for suites that start their own servers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Worker threads and forked children inherit the parent's environment (and
// this preload), so they find both variables set and create nothing.
if (!process.env.LH_DATA_DIR || !process.env.LH_AUTH_FILE) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-"));
	process.env.LH_DATA_DIR ??= path.join(dir, "data");
	process.env.LH_AUTH_FILE ??= path.join(dir, "auth.json");
	process.on("exit", () => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const realFetch = globalThis.fetch;

function hostOf(input: Parameters<typeof fetch>[0]): string {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(url).hostname;
}

globalThis.fetch = ((input, init) => {
	const host = hostOf(input);
	if (!LOOPBACK.has(host)) {
		throw new Error(`Network blocked in tests: fetch to ${host} (only loopback is allowed; stub globalThis.fetch)`);
	}
	return realFetch(input, init);
}) as typeof fetch;
