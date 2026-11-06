/**
 * Bounded uploads: the byte-counting reader, the folder-pick filter, the
 * one-file-per-request transport and the per-file import flow.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-uploads-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { readUploadForm, extraction } = await import("../src/server/index.ts");
const { filterFolderPick, skippedNotice, MAX_FILE_BYTES, MAX_REQUEST_BYTES } = await import("../src/core/upload-limits.ts");
const { createTaskQueue, fileForm } = await import("../components/add-documents-queue.ts");
const importRoute = await import("../app/api/documents/import/route.ts");
const checkRoute = await import("../app/api/documents/check/route.ts");

const originalImport = extraction.importNotes;
after(() => {
	extraction.importNotes = originalImport;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** A multipart request whose body is delivered in small chunks; `pulled` counts them. */
async function chunked(file: File, chunk = 100) {
	const form = new FormData();
	form.append("files", file);
	const source = new Response(form);
	const bytes = new Uint8Array(await source.arrayBuffer());
	const state = { pulled: 0, total: Math.ceil(bytes.length / chunk) };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.pulled >= state.total) return controller.close();
			controller.enqueue(bytes.slice(state.pulled * chunk, ++state.pulled * chunk));
		},
	});
	const request = new Request("http://localhost/x", {
		method: "POST",
		body,
		headers: { "content-type": source.headers.get("content-type")! },
		duplex: "half",
	} as RequestInit);
	return { request, state, bytes };
}

it("limits: 250 MiB per file, one file per request plus an envelope", () => {
	assert.equal(MAX_FILE_BYTES, 250 * 1024 * 1024);
	assert.ok(MAX_REQUEST_BYTES > MAX_FILE_BYTES);
});

it("the reader stops pulling at the cap and answers 413 naming the file", async () => {
	const { request, state } = await chunked(new File(["x".repeat(20_000)], "big-book.pdf"));
	const out = await readUploadForm(request, 1000);
	assert.ok(out instanceof Response);
	assert.equal(out.status, 413);
	const { error } = await out.json();
	assert.match(error, /big-book\.pdf/);
	assert.match(error, /250 MiB/);
	assert.ok(state.pulled <= 12, `stopped early: pulled ${state.pulled} of ${state.total}`);
});

it("the reader refuses a declared oversize without reading, and parses a body under the cap", async () => {
	const huge = new Request("http://localhost/x", { method: "POST", body: "x", headers: { "content-length": String(MAX_REQUEST_BYTES + 1) } });
	const refused = await readUploadForm(huge);
	assert.ok(refused instanceof Response);
	assert.equal(refused.status, 413);

	const { request } = await chunked(new File(["hello"], "ok.md"));
	const form = await readUploadForm(request, 100_000);
	assert.ok(form instanceof FormData);
	assert.equal((form.get("files") as File).name, "ok.md");
});

it("a truncated or missing multipart body is a handled 400", async () => {
	const { request, bytes } = await chunked(new File(["x".repeat(500)], "cut.md"));
	const cut = new Request("http://localhost/x", { method: "POST", body: bytes.slice(0, bytes.length - 80), headers: { "content-type": request.headers.get("content-type")! } });
	const out = await readUploadForm(cut);
	assert.ok(out instanceof Response);
	assert.equal(out.status, 400);
	const none = await readUploadForm(new Request("http://localhost/x", { method: "POST" }));
	assert.ok(none instanceof Response);
	assert.equal(none.status, 400);
});

it("folder picks drop dot-paths and unsupported types, and say how many", () => {
	const f = (name: string, rel: string) => ({ name, webkitRelativePath: rel });
	const pick = filterFolderPick([
		f("a.md", "Notes/a.md"),
		f("b.PDF", "Notes/sub/b.PDF"),
		f(".env", "Notes/.env"),
		f("c.md", "Notes/.git/c.md"),
		f("d.md", "Notes/.hidden/d.md"),
		f("pic.png", "Notes/pic.png"),
		f("e.md", ".Notes/e.md"), // a dot-named root stays importable
	]);
	assert.deepEqual(pick.accepted.map((x) => x.name), ["a.md", "b.PDF", "e.md"]);
	assert.equal(pick.hidden, 3);
	assert.equal(pick.unsupported, 1);
	assert.equal(skippedNotice(pick), "3 hidden files and 1 unsupported file skipped.");
	assert.equal(skippedNotice({ hidden: 0, unsupported: 0 }), "");
});

it("a request carries one file and only its own name, never the folder path", () => {
	const file = new File(["x"], "a.md");
	Object.defineProperty(file, "webkitRelativePath", { value: "Course/week1/a.md" });
	const form = fileForm(file, { decisions: "[null]" });
	assert.equal(form.getAll("files").length, 1);
	assert.equal((form.get("files") as File).name, "a.md");
});

it("the task queue never runs more than its limit and takes later work", async () => {
	const run = createTaskQueue(3);
	let live = 0, peak = 0;
	const job = () => run(async () => { peak = Math.max(peak, ++live); await new Promise((r) => setImmediate(r)); live--; });
	await Promise.all([...Array(5)].map(job));
	await Promise.all([...Array(5)].map(job)); // a second selection joins the same queue
	assert.equal(peak, 3);
});

/** A markdown file whose text (hence identity) is unique per `body`; front matter skips the describe model. */
const doc = (name: string, body: string) =>
	new File([`---\ntitle: "About ${body}"\nsummary: "s"\ntopics: ["t"]\n---\n\nThe notes on ${body} explain one idea in a few plain sentences.`], name);

const post = (route: { POST: (r: Request) => Promise<Response> }, url: string, file: File, decisions?: unknown[]) => {
	const form = fileForm(file, decisions ? { decisions: JSON.stringify(decisions) } : undefined);
	return route.POST(new Request(`http://localhost${url}`, { method: "POST", body: form }));
};

it("per-file requests keep the duplicate flow: skip by default, Replace on request", async () => {
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	const file = doc("one.md", "photosynthesis");

	const first = await (await post(importRoute, "/api/documents/import", file, [null])).json();
	assert.equal(first.results[0].outcome, "started");
	await new Promise((r) => setTimeout(r, 50));

	const checked = await (await post(checkRoute, "/api/documents/check", doc("renamed.md", "photosynthesis"))).json();
	assert.equal(checked.results[0].verdict.status, "duplicate");

	const skipped = await (await post(importRoute, "/api/documents/import", doc("renamed.md", "photosynthesis"), ["skip"])).json();
	assert.equal(skipped.results[0].outcome, "skipped");
	const defaulted = await (await post(importRoute, "/api/documents/import", doc("renamed.md", "photosynthesis"))).json();
	assert.equal(defaulted.results[0].outcome, "skipped");

	const replaced = await (await post(importRoute, "/api/documents/import", doc("renamed.md", "photosynthesis"), ["replace"])).json();
	assert.equal(replaced.results[0].outcome, "started");
});
