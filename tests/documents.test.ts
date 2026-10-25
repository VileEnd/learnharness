/**
 * The document library's pure core and its fs store: content identity
 * (normalisation, hash, MinHash), OCR front matter, sections, duplicate
 * classification, topics - and the DocumentStore round-trip under an
 * isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-documents-"));
process.env.LH_DATA_DIR = TMP_DATA;

const {
	classify, contentHash, describedByFrontMatter, documentIdFor, fingerprint, jaccardEstimate, minhash,
	normalizeText, normalizeTopics, parseFrontMatter, parseSections,
} = await import("../src/core/documents.ts");
const { splitPages } = await import("../src/core/document-pages.ts");
const { documentStore } = await import("../src/store/documents.ts");
import type { DocumentMeta } from "../src/core/contracts/documents.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const words = (n: number, salt = "") => Array.from({ length: n }, (_, i) => `word${i}${salt}`).join(" ");

describe("normalisation and content hash", () => {
	it("ignores front matter, page markers, whitespace and case", () => {
		const plain = "Hello   World\n\nsecond line";
		const dressed = `---\ntitle: "x"\npages: 2\n---\n<!-- page 1 -->\nhello world\n<!-- page 2 -->\nSECOND\tLINE\n`;
		assert.equal(normalizeText(dressed), "hello world second line");
		assert.equal(contentHash(dressed), contentHash(plain));
		assert.notEqual(contentHash(plain), contentHash("hello world second line extra"));
	});

	it("keepCase keeps the readable form for the describer", () => {
		assert.equal(normalizeText("---\na: 1\n---\nKeep  Case", { keepCase: true }), "Keep Case");
	});

	it("the id comes from the pdf bytes when there are any, else the text", () => {
		assert.equal(documentIdFor({ contentHash: "ab".repeat(32) }), "doc_abababababab");
		assert.equal(documentIdFor({ pdfSha256: "cd".repeat(32), contentHash: "ab".repeat(32) }), "doc_cdcdcdcdcdcd");
	});
});

describe("MinHash similarity", () => {
	const base = normalizeText(words(400));
	it("same text is 1.0, a small edit stays above the bar, different text is far", () => {
		assert.equal(jaccardEstimate(minhash(base), minhash(base)), 1);
		const edited = normalizeText(words(400).replace("word200", "changed"));
		assert.ok(jaccardEstimate(minhash(base), minhash(edited)) >= 0.85);
		assert.ok(jaccardEstimate(minhash(base), minhash(normalizeText(words(400, "x")))) < 0.5);
	});
	it("a sketch has 128 values", () => assert.equal(minhash(base).length, 128));
});

describe("front matter", () => {
	const ocr = `---
title: "LL(1)-Parsing: Tabelle"
summary: "Erklärt den Parser."
topics: ["LL(1)-Parser", "Syntaxanalyse", "ll(1)-parser"]
source: "scan.pdf"
pages: 3
sha256: "${"a".repeat(64)}"
---

# Body
`;
	it("parses the OCR format and returns the body", () => {
		const { data, body } = parseFrontMatter(ocr);
		assert.equal(data.title, "LL(1)-Parsing: Tabelle");
		assert.deepEqual(data.topics, ["LL(1)-Parser", "Syntaxanalyse", "ll(1)-parser"]);
		assert.equal(data.pages, 3);
		assert.equal(body.trim(), "# Body");
		assert.deepEqual(parseFrontMatter("no front matter"), { data: {}, body: "no front matter" });
	});
	it("describedByFrontMatter folds topics by case but keeps display casing", () => {
		const d = describedByFrontMatter(parseFrontMatter(ocr).data);
		assert.deepEqual(d?.topics, ["LL(1)-Parser", "Syntaxanalyse"]);
		assert.equal(d?.pages, 3);
		assert.equal(describedByFrontMatter({}), null);
		// An early OCR run: the filename as title, nothing else - not a content description.
		assert.equal(describedByFrontMatter({ title: "02-Folien", source: "02-Folien.pdf", pages: 14 }), null);
		assert.equal(describedByFrontMatter({ title: "aufg01-2026", source: "aufg01-2026.pdf", summary: "s", topics: ["t"] }), null);
	});
	it("topics match by NFKC case-fold", () => {
		assert.deepEqual(normalizeTopics([" Semaphor ", "semaphor", "ﬁle", "FILE"]), ["Semaphor", "ﬁle"]);
	});
});

describe("sections", () => {
	const md = `---
title: "t"
---
Intro line

# One
<!-- page 1 -->
text one
## One A
<!-- page 2 -->
text a
<!-- page 3 -->
more a
# Two
<!-- page 4 -->
\`\`\`
# not a heading
\`\`\`
text two
`;
	it("splits at headings with heading paths, page ranges and offsets", () => {
		const s = parseSections(md);
		assert.deepEqual(s.map((x) => x.headingPath), [[], ["One"], ["One", "One A"], ["Two"]]);
		assert.deepEqual(s.map((x) => [x.pageFrom, x.pageTo]), [[undefined, undefined], [1, 1], [1, 3], [3, 4]]);
		assert.deepEqual(s.map((x) => x.id), ["s1", "s2", "s3", "s4"]);
		assert.ok(md.slice(s[1]!.start, s[1]!.end).startsWith("# One"));
		assert.ok(md.slice(s[3]!.start, s[3]!.end).includes("# not a heading"));
		assert.equal(s[3]!.end, md.length);
	});
	it("plain markdown has no pages; no headings is one section", () => {
		const [only, ...rest] = parseSections("just some text\nmore");
		assert.equal(rest.length, 0);
		assert.deepEqual(only!.headingPath, []);
		assert.equal(only!.pageFrom, undefined);
	});
	it("splitPages cuts at the markers", () => {
		const pages = splitPages("---\na: 1\n---\nlead\n<!-- page 1 -->\nA\n<!-- page 2 -->\nB\n");
		assert.deepEqual(pages, [{ page: null, markdown: "lead" }, { page: 1, markdown: "A" }, { page: 2, markdown: "B" }]);
	});
});

const meta = (id: string, text: string, extra: Partial<DocumentMeta> = {}): DocumentMeta => ({
	id, ...fingerprint(text), title: `Title ${id}`, summary: "", topics: [], filenames: ["a.md"],
	importedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", origin: "markdown", sourceId: id, ...extra,
});

describe("classify", () => {
	const a = meta("doc_aaaaaaaaaaaa", words(300));
	const b = meta("doc_bbbbbbbbbbbb", words(300, "y"), { pdfSha256: "p".repeat(64) });
	const known = [a, b];
	it("new / duplicate by hash / duplicate by pdf bytes / similar", () => {
		assert.equal(classify(known, fingerprint(words(300, "z"))).status, "new");
		const dup = classify(known, fingerprint(`<!-- page 1 -->${words(300).toUpperCase()}`));
		assert.deepEqual([dup.status, dup.of?.id, dup.score], ["duplicate", a.id, 1]);
		assert.equal(classify(known, { contentHash: "", minhash: [], pdfSha256: "p".repeat(64) }).of?.id, b.id);
		const near = classify(known, fingerprint(words(300).replace("word150", "edited")));
		assert.equal(near.status, "similar");
		assert.equal(near.of?.id, a.id);
		assert.ok(near.score! >= 0.85 && near.score! < 1);
	});
});

describe("DocumentStore", () => {
	it("round-trips a document, lists newest first, ignores bad ids, removes", () => {
		const m1 = meta("doc_111111111111", words(50));
		const m2 = meta("doc_222222222222", words(50, "q"), { importedAt: "2026-10-02T00:00:00.000Z" });
		documentStore.save(m1, "# one");
		documentStore.save(m2, "# two");
		assert.deepEqual(documentStore.getMeta(m1.id), m1);
		assert.equal(documentStore.readMarkdown(m1.id), "# one");
		assert.deepEqual(documentStore.listMetas().map((m) => m.id), [m2.id, m1.id]);
		assert.equal(documentStore.getMeta("../etc"), null);
		assert.equal(documentStore.readMarkdown("doc_nope"), null);
		assert.ok(fs.existsSync(path.join(TMP_DATA, "documents", m1.id, "document.md")));
		assert.equal(documentStore.remove(m1.id), true);
		assert.equal(documentStore.remove(m1.id), false);
		assert.deepEqual(documentStore.listMetas().map((m) => m.id), [m2.id]);
	});
});
