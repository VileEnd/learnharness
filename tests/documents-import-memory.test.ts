/**
 * A text import must not cost a multiple of the file's size in memory (one
 * Node process serves every user inside a hard container limit). Imports a
 * generated plain-text file through the document service - the real store, the
 * real search index, and the extraction chunking the pipeline does before its
 * first model call; no model, embedding or OCR call - and asserts the PEAK
 * resident growth. Linux only (peak RSS is read from /proc and reset around
 * the import); elsewhere the test is skipped.
 *
 * Before the fix a text import peaked at about 70-80x the file: it fingerprinted
 * the whole text up to four times, and each fingerprint built a word array and a
 * set of every 5-word shingle (about 35x on its own). After it: about 15x here,
 * of which the search index being built is about half.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-memory-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.OCR_URL;

const { createDocumentService } = await import("../src/server/documents.ts");
const { documentStore } = await import("../src/store/documents.ts");
const { createOcrClient } = await import("../src/server/ocr-client.ts");
const { createDocIndex } = await import("../src/server/doc-index.ts");
const { chunkDocument } = await import("../src/agent/subagents/section-chunks.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const STATUS = "/proc/self/status";
const CLEAR_REFS = "/proc/self/clear_refs";
const mebibytes = (kb: string | undefined) => Number(kb) / 1024;
const field = (name: string) => mebibytes(new RegExp(`${name}:\\s+(\\d+) kB`).exec(fs.readFileSync(STATUS, "utf8"))?.[1]);

/** Peak-RSS measurement works where /proc has VmHWM and it can be reset. */
function canMeasurePeak(): boolean {
	try {
		fs.writeFileSync(CLEAR_REFS, "5");
		return Number.isFinite(field("VmHWM"));
	} catch {
		return false;
	}
}

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

/** About `mb` MiB of varied prose with headings (a deterministic LCG, so every run reads the same file). */
function prose(mb: number): string {
	let seed = 12345;
	const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
	const syllables = ["ka", "ri", "mo", "tu", "le", "san", "dor", "vi", "pen", "qua", "lin", "bra", "zel", "fo", "gus", "hae", "ix", "yo", "ne", "cat"];
	const vocabulary = Array.from({ length: 6000 }, () =>
		Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => syllables[Math.floor(rnd() * syllables.length)]).join(""),
	);
	const word = () => vocabulary[Math.floor(Math.pow(rnd(), 2.2) * vocabulary.length)]!;
	const parts: string[] = [];
	let size = 0;
	for (let section = 0; size < mb * 2 ** 20; section++) {
		let text = section % 40 === 0 ? `# Part ${section / 40 + 1} ${word()}\n\n` : "";
		text += `## Section ${section} ${word()} ${word()}\n\n`;
		for (let p = 3 + Math.floor(rnd() * 5); p > 0; p--) {
			const sentence = Array.from({ length: 40 + Math.floor(rnd() * 120) }, word).join(" ");
			text += `${sentence}.\n\n`;
		}
		parts.push(text);
		size += text.length;
	}
	return parts.join("");
}

describe("importing a large text file", () => {
	it("peaks at a small multiple of the file's size", { skip: !canMeasurePeak() && "peak RSS is not readable here" }, async () => {
		const text = prose(8);
		const bytes = new TextEncoder().encode(text);
		const index = createDocIndex({ store: documentStore, embedder: () => null, autoTick: false });
		await index.search({ query: "warm up" }); // a running app has built its index: saves now feed it
		const service = createDocumentService({
			store: { ...documentStore, save: (meta, markdown) => (documentStore.save(meta, markdown), index.indexDocument(meta.id)) },
			// What the pipeline does with the text before its first model call.
			importNotes: async (input) => (chunkDocument(input.text, input.sections ?? [], 4096), { nodes: 0, chains: 0 }),
			describe: async () => ({ title: "Generated", summary: "s", topics: [] }),
			ocr: createOcrClient({ baseUrl: () => undefined }),
			notify: () => {},
			pollMs: 0,
		});

		gc();
		const before = field("VmRSS");
		fs.writeFileSync(CLEAR_REFS, "5");
		const [ticket] = await service.importFiles([{ name: "big.md", bytes }]);
		const done = await ticket!.completion;
		const peak = field("VmHWM") - before;

		assert.deepEqual([ticket!.outcome, done?.ok], ["started", true]);
		const size = bytes.length / 2 ** 20;
		assert.ok(peak < size * 25, `peak resident growth ${peak.toFixed(0)} MiB is ${(peak / size).toFixed(1)}x the ${size.toFixed(1)} MiB file; the bound is 25x`);
	});
});
