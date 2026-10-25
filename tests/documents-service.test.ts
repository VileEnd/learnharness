/**
 * The document service end to end with stubs at its seams (extraction, the
 * describe agent, the OCR sidecar) over the real fs store under an isolated
 * LH_DATA_DIR - plus the check/import/list routes. Pins: the verdicts, the
 * skip / replace / new decisions, that the filename never reaches the
 * describer or the extractor, the PDF scan flow (progress row, front
 * matter, cost on the meta, duplicate-after-scan) and the refusals.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-service-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.OCR_URL;

const { createDocumentService, scanStatuses } = await import("../src/server/documents.ts");
const { documentStore } = await import("../src/store/documents.ts");
const { createOcrClient } = await import("../src/server/ocr-client.ts");
const checkRoute = await import("../app/api/documents/check/route.ts");
const importRoute = await import("../app/api/documents/import/route.ts");
const listRoute = await import("../app/api/documents/route.ts");
const oneRoute = await import("../app/api/documents/[id]/route.ts");
const estimateRoute = await import("../app/api/documents/estimate/route.ts");
import type { OcrClient, OcrJob } from "../src/server/ocr-client.ts";
import type { NotesImportInput } from "../src/agent/subagents/extraction.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(TMP_DATA, "documents"), { recursive: true, force: true }));

const bytes = (s: string) => new TextEncoder().encode(s);
const prose = (n: number, salt = "") => Array.from({ length: n }, (_, i) => `term${i}${salt}`).join(" ");
const md = (name: string, text: string) => ({ name, bytes: bytes(text) });
const pdf = (name: string, salt: string) => ({ name, bytes: bytes(`%PDF-1.7 ${salt}`) });

function harness(over: { ocr?: Partial<OcrClient>; describe?: (text: string) => Promise<{ title: string; summary: string; topics: string[] }> } = {}) {
	const extracted: NotesImportInput[] = [];
	const described: string[] = [];
	const pushed: unknown[] = [];
	const unconfigured = createOcrClient({ baseUrl: () => undefined });
	const service = createDocumentService({
		store: documentStore,
		importNotes: async (input) => { extracted.push(input); return { nodes: 1, chains: 0 }; },
		describe: over.describe ?? (async (text) => { described.push(text); return { title: "Described title", summary: "sum", topics: ["Topic A", "topic a"] }; }),
		ocr: { ...unconfigured, ...over.ocr } as OcrClient,
		notify: (e) => { pushed.push(e); },
		pollMs: 0,
	});
	return { service, extracted, described, pushed };
}

describe("markdown: check and import", () => {
	it("a new file is described from content only (never the filename), stored, extracted by title", async () => {
		const { service, extracted, described } = harness();
		const text = `# Mutex basics\n\n${prose(120)}`;
		const [ticket] = await service.importFiles([md("secret-filename.md", text)]);
		assert.equal(ticket!.outcome, "started");
		assert.match(ticket!.docId!, /^doc_[0-9a-f]{12}$/);
		const done = await ticket!.completion!;
		assert.deepEqual([done.ok, done.stats], [true, { nodes: 1, chains: 0 }]);
		assert.equal(described.length, 1);
		assert.ok(!described[0]!.includes("secret-filename"), "the describer never sees the name");
		assert.ok(described[0]!.startsWith("# Mutex basics"), "readable, not lowercased");
		assert.deepEqual(extracted.map((e) => [e.id, e.title]), [[ticket!.docId, "Described title"]]);
		const meta = documentStore.getMeta(ticket!.docId!)!;
		assert.deepEqual([meta.title, meta.topics, meta.filenames, meta.origin, meta.sourceId], ["Described title", ["Topic A"], ["secret-filename.md"], "markdown", meta.id]);
		assert.equal(documentStore.readMarkdown(meta.id), text);
	});

	it("OCR front matter replaces the describe call", async () => {
		const { service, described } = harness();
		const [t] = await service.importFiles([md("a.md", `---\ntitle: "From matter"\nsummary: "s"\ntopics: ["x"]\n---\n${prose(80)}`)]);
		await t!.completion;
		assert.equal(described.length, 0);
		assert.equal(documentStore.getMeta(t!.docId!)!.title, "From matter");
	});

	it("check: new, then duplicate under another name, then similar; skip is the default and runs nothing", async () => {
		const { service, extracted } = harness();
		const text = `# T\n\n${prose(300)}`;
		const first = (await service.importFiles([md("one.md", text)]))[0]!;
		await first.completion;
		const [dup, similar, fresh] = await service.check([
			md("two.md", `<!-- page 1 -->\n${text.toUpperCase()}`),
			md("three.md", text.replace("term150", "edited")),
			md("four.md", prose(300, "z")),
		]);
		assert.deepEqual([dup!.verdict.status, dup!.verdict.of?.id], ["duplicate", first.docId]);
		assert.equal(similar!.verdict.status, "similar");
		assert.ok(similar!.verdict.score! >= 0.85);
		assert.equal(fresh!.verdict.status, "new");
		const tickets = await service.importFiles([md("two.md", text), md("three.md", text.replace("term150", "edited"))]);
		assert.deepEqual(tickets.map((t) => t.outcome), ["skipped", "skipped"]);
		assert.equal(extracted.length, 1);
		assert.equal(documentStore.listMetas().length, 1);
	});

	it("replace keeps the docId, swaps the text, adds the alias and re-extracts; new makes a second document", async () => {
		const { service, extracted } = harness();
		const text = `# T\n\n${prose(300)}`;
		const orig = (await service.importFiles([md("one.md", text)]))[0]!;
		await orig.completion;
		const edited = text.replace("term150", "edited");

		const [replaced] = await service.importFiles([md("v2.md", edited)], ["replace"]);
		await replaced!.completion;
		assert.equal(replaced!.docId, orig.docId);
		assert.equal(documentStore.listMetas().length, 1);
		assert.equal(documentStore.readMarkdown(orig.docId!), edited);
		assert.deepEqual(documentStore.getMeta(orig.docId!)!.filenames, ["one.md", "v2.md"]);
		assert.equal(extracted.length, 2);
		assert.equal(extracted[1]!.id, orig.docId, "same graph source");

		const [second] = await service.importFiles([md("v3.md", text.replace("term10 ", "other "))], ["new"]);
		await second!.completion;
		assert.notEqual(second!.docId, orig.docId);
		assert.equal(documentStore.listMetas().length, 2);
	});

	it("binary and empty files are refused per file; a refused describe stores nothing", async () => {
		const { service } = harness({ describe: async () => { throw new Error("no model"); } });
		const tickets = await service.importFiles([{ name: "x.bin", bytes: new Uint8Array([1, 0, 2]) }, md("empty.md", "  \n"), md("n.md", prose(40))]);
		assert.deepEqual(tickets.map((t) => t.outcome), ["failed", "failed", "failed"]);
		assert.match(tickets[2]!.error!, /no model/);
		assert.equal(documentStore.listMetas().length, 0);
	});
});

describe("pdf", () => {
	const ocrMarkdown = (title: string, body: string) => `---\ntitle: "${title}"\nsummary: "s"\ntopics: ["Scans"]\npages: 4\n---\n\n<!-- page 1 -->\n# ${title}\n${body}\n<!-- page 2 -->\nmore`;
	function sidecar(markdown: string, opts: { known?: boolean } = {}) {
		const polls: OcrJob[] = [];
		const seenRows: string[] = [];
		const file = (status: "running" | "done", done: number) => ({
			name: "scan.pdf", sha256: "x", status, pages: 4, done_pages: done, failed_pages: [], markdown: status === "done" ? "scan.md" : null,
			title: "Scan title", summary: null, topics: [], cost_usd: status === "done" ? 0.0123 : 0, error: null,
		});
		let n = 0;
		const ocr: Partial<OcrClient> = {
			configured: () => true,
			assertCanScan: () => {},
			start: async () => "job1",
			job: async () => {
				seenRows.push(...scanStatuses().map((s) => s.title));
				const done = ++n >= 3;
				const job: OcrJob = { id: "job1", status: done ? "done" : "running", strategy: "ocr+vision", usd: 0.0123, files: [file(done ? "done" : "running", done ? 4 : n)] };
				polls.push(job);
				return job;
			},
			markdown: async () => markdown,
			bySha: async () => (opts.known ? { job: "job0", markdown: "scan.md", title: "t", summary: "", topics: [], pages: 4, cost_usd: 0.5 } : null),
		};
		return { ocr, polls, seenRows };
	}

	it("scans, shows progress rows, stores origin pdf with pages and cost, extracts by title; a repeat is a duplicate by bytes", async () => {
		const side = sidecar(ocrMarkdown("Scanned lecture", prose(100)));
		const { service, extracted } = harness({ ocr: side.ocr });
		const file = pdf("lecture.pdf", "a");
		const [t] = await service.importFiles([file]);
		assert.equal(t!.outcome, "started");
		const done = await t!.completion!;
		assert.equal(done.ok, true);
		assert.equal(side.seenRows[0], "Scanning lecture", "the row starts with the name, before the sidecar knows the title");
		assert.ok(side.seenRows.includes("Scanning Scan title · 2/4 pages"), "then the sidecar's title and page progress");
		assert.deepEqual(scanStatuses(), [], "the row is gone when the scan ends");
		const meta = documentStore.getMeta(t!.docId!)!;
		assert.deepEqual([meta.origin, meta.pages, meta.title, meta.ocr], ["pdf", 4, "Scanned lecture", { job: "job1", strategy: "ocr+vision", costUsd: 0.0123 }]);
		assert.equal(meta.pdfSha256?.length, 64);
		assert.equal(extracted[0]!.title, "Scanned lecture");
		assert.match(extracted[0]!.text, /^\s*<!-- page 1 -->/, "front matter is not extracted");

		const [again] = await service.check([file]);
		assert.deepEqual([again!.kind, again!.verdict.status, again!.verdict.of?.id], ["pdf", "duplicate", t!.docId]);
	});

	it("a scan whose text duplicates another document is skipped unless replace / new was chosen", async () => {
		const body = prose(100);
		const side = sidecar(ocrMarkdown("Same text", body));
		const { service } = harness({ ocr: side.ocr });
		const first = (await service.importFiles([md("notes.md", ocrMarkdown("Same text", body))]))[0]!;
		await first.completion;
		const [t] = await service.importFiles([pdf("other.pdf", "b")]);
		const done = await t!.completion!;
		assert.deepEqual([done.ok, done.outcome, done.duplicateOf?.id], [true, "skipped", first.docId]);
		assert.equal(documentStore.listMetas().length, 1);
	});

	it("the sidecar's earlier conversion is reused: checked as scanned, imported without a new job", async () => {
		const side = sidecar(ocrMarkdown("Known", prose(60)), { known: true });
		let started = 0;
		const { service } = harness({ ocr: { ...side.ocr, start: async () => { started++; return "never"; } } });
		const [c] = await service.check([pdf("k.pdf", "c")]);
		assert.deepEqual([c!.verdict.status, c!.scanned], ["new", true]);
		const [t] = await service.importFiles([pdf("k.pdf", "c")]);
		await t!.completion;
		assert.equal(started, 0);
		assert.equal(documentStore.getMeta(t!.docId!)!.ocr?.costUsd, 0.5);
	});

	it("refuses clearly without OCR_URL, and without an OpenRouter key", async () => {
		const none = harness();
		const [a] = await none.service.importFiles([pdf("a.pdf", "d")]);
		assert.deepEqual([a!.outcome, a!.code], ["failed", "ocr_not_configured"]);
		assert.match(a!.error!, /OCR/);
		const keyless = createOcrClient({ baseUrl: () => "http://ocr.invalid", key: () => undefined, fetch: async () => new Response("{}", { status: 404 }) });
		const { service } = harness({ ocr: keyless });
		const [b] = await service.importFiles([pdf("b.pdf", "e")]);
		assert.deepEqual([b!.outcome, b!.code], ["failed", "openrouter_key_missing"]);
		assert.match(b!.error!, /PDF scanning needs an OpenRouter key/);
	});

	it("aborting the scan row stops the job and reports it", async () => {
		const side = sidecar("x");
		const never = { ...side.ocr, job: async () => ({ id: "j", status: "running" as const, strategy: "vision", usd: 0, files: [] }) };
		const { service, pushed } = harness({ ocr: never });
		const [t] = await service.importFiles([pdf("slow.pdf", "f")]);
		await new Promise((r) => setTimeout(r, 10));
		const [row] = scanStatuses();
		assert.ok(row);
		(await import("../src/server/documents.ts")).abortScan(row!.id);
		const done = await t!.completion!;
		assert.deepEqual([done.ok, done.outcome], [false, "aborted"]);
		assert.equal(pushed.length, 1);
	});
});

describe("the describe agent", () => {
	it("submits title, summary and topics from the first 6000 chars on the cheap slot; refuses without a model", async () => {
		const { createDescriber, DESCRIBE_CHARS } = await import("../src/agent/subagents/describe.ts");
		const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
		const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");
		let prompt = "";
		const faux = createFauxCore({});
		faux.setResponses([(context: unknown) => {
			prompt = JSON.stringify(context);
			return fauxAssistantMessage([fauxToolCall("describe_document", { title: " Semaphores ", summary: "About semaphores.", topics: ["Semaphor"] })], { stopReason: "toolUse" });
		}]);
		const roles: string[] = [];
		const describer = createDescriber({
			engineFor: (role) => { roles.push(role); return { model: faux.getModel(), streamFn: faux.streamSimple }; },
		});
		const out = await describer.describe(`START ${"x".repeat(DESCRIBE_CHARS)}END`);
		assert.deepEqual(out, { title: "Semaphores", summary: "About semaphores.", topics: ["Semaphor"] });
		assert.deepEqual(roles, ["describer"]);
		assert.ok(prompt.includes("START") && !prompt.includes("END"), "only the opening is read");
		await assert.rejects(createDescriber({ engineFor: () => undefined }).describe("text"), ModelsNotConfiguredError);
	});
});

describe("routes", () => {
	const form = (files: File[], extra: Record<string, string> = {}) => {
		const f = new FormData();
		for (const file of files) f.append("files", file);
		for (const [k, v] of Object.entries(extra)) f.append(k, v);
		return f;
	};
	const req = (url: string, body: FormData) => new Request(`http://localhost${url}`, { method: "POST", body });
	const withMatter = (t: string, body: string) => `---\ntitle: "${t}"\nsummary: ""\ntopics: []\n---\n${body}`;

	it("check reports statuses per file; import answers 202 with tickets; list and get serve the library", async () => {
		const body = prose(200);
		const imp = await importRoute.POST(req("/api/documents/import", form([new File([withMatter("Route doc", body)], "r.md")])));
		assert.equal(imp.status, 202);
		const { results } = await imp.json();
		assert.equal(results[0].outcome, "started");
		const id = results[0].docId as string;
		assert.ok(!("completion" in results[0]));

		const chk = await checkRoute.POST(req("/api/documents/check", form([
			new File([body], "same-text-other-name.md"),
			new File([prose(200, "n")], "fresh.md"),
			new File(["%PDF-1.4 zzz"], "x.pdf"),
		])));
		const checked = (await chk.json()).results;
		assert.deepEqual(checked.map((r: { verdict: { status: string } }) => r.verdict.status), ["duplicate", "new", "new"]);
		assert.equal(checked[0].verdict.of.id, id);
		assert.equal(checked[2].kind, "pdf");

		const skipped = await (await importRoute.POST(req("/api/documents/import", form([new File([body], "again.md")], { decisions: '["skip"]' })))).json();
		assert.equal(skipped.results[0].outcome, "skipped");

		const list = await (await listRoute.GET()).json();
		assert.equal(list.documents.length, 1);
		assert.ok(!("minhash" in list.documents[0]));
		const one = await oneRoute.GET(new Request("http://localhost"), { params: Promise.resolve({ id }) });
		assert.match((await one.json()).markdown, /Route doc/);
		assert.equal((await oneRoute.GET(new Request("http://localhost"), { params: Promise.resolve({ id: "doc_missing" }) })).status, 404);
	});

	it("rejects empty requests and bad decisions; estimate needs a PDF and a configured sidecar", async () => {
		assert.equal((await checkRoute.POST(req("/api/documents/check", form([])))).status, 400);
		assert.equal((await importRoute.POST(req("/api/documents/import", form([new File(["x"], "a.md")], { decisions: "nope" })))).status, 400);
		assert.equal((await estimateRoute.POST(req("/api/documents/estimate", form([new File(["x"], "a.md")])))).status, 400);
		const est = await estimateRoute.POST(req("/api/documents/estimate", form([new File(["%PDF-1.4 e"], "a.pdf")])));
		assert.equal(est.status, 503);
		assert.equal((await est.json()).code, "ocr_not_configured");
	});
});
