/**
 * Section-aware chunking (PR H): whole sections fill chunks greedily, an
 * oversize section splits by paragraph, a chunk never spans two top-level
 * headings, and the header names the document, section path, pages and
 * topics - never a filename - over text with the page markers stripped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSections } from "../src/core/documents.ts";
import { chunkDocument, documentChunkView, locationLabel, readableText } from "../src/agent/subagents/section-chunks.ts";

const para = (word: string, n: number) => Array.from({ length: n }, () => word).join(" ");

const DOC = [
	"<!-- page 1 -->",
	"# Betriebssysteme",
	"![page 1](page-1.png)",
	"Intro text alpha.",
	"<!-- page 3 -->",
	"## 2 Kontextwechsel",
	"Switching text beta.",
	"<!-- page 4 -->",
	"### 2.1 Register",
	"Register text gamma.",
	"<!-- page 7 -->",
	"# Zweites Kapitel",
	"Second chapter delta.",
].join("\n");

describe("chunkDocument", () => {
	const sections = parseSections(DOC);

	it("packs whole sections greedily but never across a top-level heading", () => {
		const chunks = chunkDocument(DOC, sections, 10_000);
		assert.equal(chunks.length, 2, "one chunk per top-level heading even though everything fits");
		assert.deepEqual(chunks[0]!.sections.map((s) => s.id), ["s1", "s2", "s3"]);
		assert.deepEqual(chunks[1]!.sections.map((s) => s.id), ["s4"]);
	});

	it("starts a new chunk when the next whole section would exceed the budget", () => {
		const chunks = chunkDocument(DOC, sections, 20);
		assert.deepEqual(chunks.map((c) => c.sections.map((s) => s.id)), [["s1"], ["s2"], ["s3"], ["s4"]]);
	});

	it("splits an oversize section by paragraphs, keeping its id on every piece", () => {
		const text = `# Big\n\n${para("alpha", 40)}\n\n${para("beta", 40)}\n\n${para("gamma", 40)}\n`;
		const big = parseSections(text);
		assert.equal(big.length, 1);
		const chunks = chunkDocument(text, big, 50); // ~200 chars per chunk
		assert.ok(chunks.length >= 3, `split into pieces (got ${chunks.length})`);
		for (const c of chunks) {
			assert.deepEqual(c.sections.map((s) => s.id), ["s1"]);
			assert.ok(Math.ceil(c.body.length / 4) <= 75, "each piece stays near the budget");
		}
		assert.deepEqual(chunks.map((c) => c.piece?.i), chunks.map((_, i) => i + 1));
		assert.match(locationLabel(chunks[1]!), /part 2\/\d/);
	});

	it("strips page markers and page-image lines from what the extractor reads", () => {
		const [first] = chunkDocument(DOC, sections, 10_000);
		assert.ok(!/<!--\s*page/i.test(first!.body));
		assert.ok(!first!.body.includes("![page"));
		assert.ok(first!.body.includes("Intro text alpha."));
		assert.equal(readableText("a\n<!-- page 2 -->\n![page 2](x.png)\nb"), "a\nb");
	});

	it("the header carries title, section path, pages, topics and citable ids - not a filename", () => {
		const chunks = chunkDocument(DOC, sections, 10_000);
		const view = documentChunkView({ title: "Betriebssysteme Skript", topics: ["Kontextwechsel", "Semaphoren"] }, chunks[0]!, { i: 1, n: 2 });
		const [head, topics, ids] = view.split("\n");
		assert.match(head!, /^DOCUMENT: Betriebssysteme Skript — § Betriebssysteme … Betriebssysteme › 2 Kontextwechsel › 2\.1 Register \(pp\. 1–4\) \[stretch 1\/2\]$/);
		assert.equal(topics, "THE DOCUMENT'S TOPICS: Kontextwechsel; Semaphoren");
		assert.match(ids!, /s3 = Betriebssysteme › 2 Kontextwechsel › 2\.1 Register \(p\. 4\)/);
		assert.ok(view.includes("[section s2]"));
		assert.ok(!/\.md|\.pdf/.test(view), "no filename anywhere");
	});

	it("a single section reads as § path (pages)", () => {
		const one = chunkDocument(DOC, sections, 20)[2]!;
		assert.equal(locationLabel(one), "§ Betriebssysteme › 2 Kontextwechsel › 2.1 Register (p. 4)");
	});
});
