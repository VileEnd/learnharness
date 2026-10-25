/**
 * POST /api/graph/import is now a thin, blocking, markdown-only alias of the
 * document library's import. CONTENT decides, not the filename: identical
 * text is one document however many names it arrives under, and a repeat is
 * skipped instead of re-extracted (the old "always re-extract" pin is
 * reversed - the pipeline itself still extracts whatever it is handed, see
 * tests/extraction.test.ts). Runs under an isolated LH_DATA_DIR (the library
 * is real fs); files carry OCR-style front matter so no describe model runs.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-import-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction } = await import("../src/server/index.ts");
const { ModelsNotConfiguredError, ProviderKeyMissingError } = await import("../src/core/settings.ts");
import type { NotesImportError as NotesImportErrorType } from "../src/agent/subagents/extraction.ts";
const { createExtractionPipeline, NotesImportError } = await import("../src/agent/subagents/extraction.ts");
const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { stores } = await import("../src/server/stores.ts");
import type { GraphStore } from "../src/core/ports.ts";
import type { GraphNode, GraphChain, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";

const original = extraction.importNotes;
after(() => {
	extraction.importNotes = original;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** A markdown file whose text (hence identity) is unique per `body`. */
const doc = (name: string, body = name) =>
	new File([`---\ntitle: "About ${body}"\nsummary: "s"\ntopics: ["t"]\n---\n\nThe notes on ${body} explain one idea in a few plain sentences.`], name);

function request(files: File[]) {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

it("route keeps request positions and mixed per-file outcomes/config details", async () => {
	extraction.importNotes = async ({ filePath }) => {
		await new Promise((resolve) => setTimeout(resolve, filePath === "slow.md" ? 25 : 1));
		if (filePath === "models.md") throw new ModelsNotConfiguredError(["cheap"]);
		if (filePath === "key.md") throw new ProviderKeyMissingError("openai", ["cheap"]);
		if (["failed", "partial", "aborted", "busy"].includes(filePath)) throw new NotesImportError(filePath as NotesImportErrorType["outcome"], { nodes: 2, chains: 1 }, `synthetic ${filePath}`);
		if (filePath === "unknown.md") throw new Error("synthetic unknown error");
		return { nodes: 0, chains: 0 };
	};
	const names = ["slow.md", "same.md", "failed", "partial", "aborted", "busy", "models.md", "key.md", "unknown.md"];
	const response = await POST(request(names.map((n) => doc(n))));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(results.length, names.length);
	for (const [requestIndex, filePath] of names.entries()) {
		const result = results.find((r: { requestIndex: number }) => r.requestIndex === requestIndex);
		assert.equal(result.filePath, filePath);
		if (["failed", "partial", "aborted", "busy"].includes(filePath)) {
			assert.equal(result.outcome, filePath);
			assert.equal(result.ok, false);
			assert.deepEqual(result.stats, { nodes: 2, chains: 1 });
		} else if (["slow.md", "same.md"].includes(filePath)) {
			assert.equal(result.outcome, "completed"); assert.equal(result.ok, true);
		} else { assert.equal(result.ok, false); assert.equal(result.outcome, "failed"); }
	}
	assert.deepEqual(results.find((r: { filePath: string }) => r.filePath === "models.md").missing, ["cheap"]);
	const key = results.find((r: { filePath: string }) => r.filePath === "key.md");
	assert.equal(key.code, "provider_key_missing"); assert.equal(key.provider, "openai"); assert.deepEqual(key.slots, ["cheap"]);
});

it("real route plus in-memory ledgers and faux stages extract identical text once, however it is named", async () => {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const sources = new Map<string, NotesSource>();
	const graphStore: GraphStore = {
		appendNode: (node) => { nodes.push(node); }, readNodes: () => [...nodes],
		appendChain: (chain) => { chains.push(chain); }, readChains: () => [...chains],
		appendCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }, readCheckpoints: () => [...checkpoints],
		appendCoverage: () => {}, readCoverage: () => [],
		upsertSource: (source) => { sources.set(source.id, { ...source, extractions: sources.get(source.id)?.extractions ?? [] }); },
		readSources: () => [...sources.values()],
		appendSourceUsage: (id, usage) => { sources.get(id)!.extractions!.push(usage); },
		readPositions: () => ({}), writePositions: () => {}, rewriteLedgers: () => {},
	};
	let calls = 0;
	const pipeline = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		engineFor: (role) => {
			const faux = createFauxCore({});
			faux.setResponses([() => {
				if (role === "extractor") calls++;
				return fauxAssistantMessage([fauxToolCall(role === "extractor" ? "submit_findings" : "submit_review", role === "extractor" ? {
					propositions: [{ id: "p1", name: "Synthetic import", statement: "Identical notes are one document.", aliases: [] }], chains: [],
				} : { links: [] })], { stopReason: "toolUse" });
			}]);
			return { model: faux.getModel(), streamFn: faux.streamSimple };
		},
	});
	extraction.importNotes = pipeline.importNotes;
	const names = ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"];
	for (let pass = 0; pass < 2; pass++) {
		const response = await POST(request(names.map((n) => doc(n, "identical"))));
		const { results } = await response.json();
		assert.equal(results.length, 4);
		assert.ok(results.every((r: { ok: boolean; outcome: string }) => r.ok && r.outcome === "completed"));
		assert.deepEqual(
			results.map((r: { skipped?: boolean }) => Boolean(r.skipped)),
			pass === 0 ? [false, true, true, true] : [true, true, true, true],
			"only the first copy of new content runs",
		);
	}
	assert.equal(calls, 1, "one extractor call for four names and two passes");
	assert.equal(nodes.length, 1);
	assert.equal(sources.size, 1);
	const [source] = sources.values();
	assert.match(source!.id, /^doc_[0-9a-f]{12}$/, "the graph source is the document, not a path hash");
	assert.equal(source!.filePath, "About identical", "and shows its title");
});

it("route refuses a PDF and answers 400 without files", async () => {
	const pdf = new File(["%PDF-1.4 minimal"], "scan.pdf", { type: "application/pdf" });
	const { results } = await (await POST(request([pdf]))).json();
	assert.equal(results[0].ok, false);
	assert.match(results[0].error, /Add documents/);
	const empty = await POST(request([]));
	assert.equal(empty.status, 400);
	assert.deepEqual(await empty.json(), { results: [], error: "no files" });
});
