/**
 * The library service over a COPY of the golden data dir (real chats, real
 * ledgers): the full bundle, learner model included, stays conformant.
 * The copy keeps tests/fixtures/golden-data untouched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-okf-golden-"));
fs.cpSync(path.join(import.meta.dirname, "fixtures", "golden-data"), TMP, { recursive: true });
process.env.LH_DATA_DIR = TMP;
delete process.env.LH_LIBRARY_DIR;

const { okfBundleStore } = await import("../src/store/okf.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { documentStore } = await import("../src/store/documents.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { learnerStore } = await import("../src/store/learner.ts");
const { createLibrary } = await import("../src/server/okf.ts");
const { checkOkfConformance } = await import("../src/core/okf.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

it("the full render on golden data is conformant, me/ included", () => {
	const library = createLibrary({
		okfStore: okfBundleStore,
		graphStore,
		documentStore,
		chatStore,
		learnerStore,
		settings: () => null as never,
		force: true,
		now: () => new Date("2026-10-25T12:00:00Z"),
	});
	const started = performance.now();
	const files = library.renderExport().filter((f) => f.path !== "viz.html");
	console.info(`[golden] rendered ${files.length} files in ${Math.round(performance.now() - started)} ms`);
	assert.deepEqual(checkOkfConformance(files), []);
	assert.ok(files.some((f) => f.path === "me/overview.md"));
});
