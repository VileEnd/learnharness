/**
 * Document search, pure (PR I): the tokenizer's German/English folding, BM25
 * ranking on a tiny corpus, Reciprocal Rank Fusion, chunking that keeps page
 * ranges and offsets, snippets, and the exact-text slicer behind
 * read_document. No I/O.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	Bm25,
	chunkDocument,
	cosine,
	documentMatches,
	rrf,
	sliceDocument,
	snippetAround,
	tokenize,
	topicMatches,
} from "../src/core/doc-search.ts";
import { parseSections } from "../src/core/documents.ts";

describe("tokenize", () => {
	it("lowercases, folds umlauts and the sharp s, and strips punctuation", () => {
		const t = tokenize("Größe, Übung!");
		for (const want of ["groess", "uebung", "ubung"]) assert.ok(t.includes(want), want);
		assert.ok(t.every((x) => /^[a-z]+$/.test(x)), "no punctuation or capitals survive");
		assert.ok(tokenize("Märchen").includes(tokenize("Maerchen")[0]!), "ae form");
		assert.ok(tokenize("Märchen").includes(tokenize("Marchen")[0]!), "the plain a variant is indexed too");
		assert.deepEqual(tokenize("STRASSE"), tokenize("Straße"));
	});

	it("a typed ae/oe/ue and a plain a/o/u both reach the umlaut word", () => {
		const doc = new Set(tokenize("Die Mütter und Väter"));
		for (const q of ["Mütter", "Muetter", "Mutter"]) assert.ok(tokenize(q).some((t) => doc.has(t)), q);
	});

	it("stems simple German and English plurals to one term", () => {
		assert.deepEqual(tokenize("Semaphoren"), tokenize("Semaphore"));
		assert.deepEqual(tokenize("locks"), tokenize("lock"));
		assert.deepEqual(tokenize("process"), tokenize("processes"));
	});

	it("keeps math-ish pieces whole", () => {
		const t = tokenize("Laufzeit O(n) und O(n log n), LL(1), C++ sowie x^2.");
		for (const piece of ["o(n)", "o(nlogn)", "ll(1)", "c++"]) assert.ok(t.includes(piece), piece);
	});
});

describe("Bm25", () => {
	const corpus: [string, string][] = [
		["mutex", "Ein Mutex schützt einen kritischen Abschnitt vor gleichzeitigem Zugriff mehrerer Threads"],
		["sem", "Semaphoren zählen freie Ressourcen; wait und signal ändern den Zähler der Semaphore"],
		["sort", "Lineare Suche hat im schlechtesten Fall Laufzeit O(n)"],
	];
	const index = new Bm25();
	for (const [id, text] of corpus) index.add(id, tokenize(text));

	it("ranks the passage that contains the query terms first, across the plural", () => {
		assert.equal(index.search(tokenize("Semaphore Zähler"))[0]?.id, "sem");
		assert.equal(index.search(tokenize("kritischer Abschnitt"))[0]?.id, "mutex");
		assert.equal(index.search(tokenize("O(n)"))[0]?.id, "sort");
	});

	it("matches nothing for unknown terms, honours the filter, and forgets removed ids", () => {
		assert.deepEqual(index.search(tokenize("Kartoffel")), []);
		assert.deepEqual(index.search(tokenize("Semaphore"), (id) => id !== "sem"), []);
		const copy = new Bm25();
		copy.add("a", tokenize("alpha beta"));
		copy.remove("a");
		assert.deepEqual(copy.search(tokenize("alpha")), []);
		assert.equal(copy.size, 0);
	});
});

describe("rrf and cosine", () => {
	it("fuses rankings: agreement beats a single first place; ties keep first appearance", () => {
		const fused = rrf([["a", "b", "c"], ["b", "a", "d"]]).map((r) => r.id);
		assert.deepEqual(fused.slice(0, 2), ["a", "b"]);
		assert.deepEqual(fused.slice(2), ["c", "d"]);
		assert.deepEqual(rrf([["x", "y"], []]).map((r) => r.id), ["x", "y"]);
		assert.ok(Math.abs(rrf([["x"]])[0]!.score - 1 / 61) < 1e-12, "k = 60");
	});

	it("cosine is 1 for parallel, 0 for orthogonal and for zero vectors", () => {
		assert.ok(Math.abs(cosine([1, 2], [2, 4]) - 1) < 1e-9);
		assert.equal(cosine([1, 0], [0, 1]), 0);
		assert.equal(cosine([0, 0], [1, 1]), 0);
	});
});

const para = (n: number, word: string) => Array.from({ length: n }, () => word).join(" ");

const DOC = [
	"---\ntitle: T\n---",
	"<!-- page 1 -->",
	"# Mutex",
	"",
	"Intro zum Mutex.",
	"",
	"<!-- page 2 -->",
	"## Details",
	"",
	para(150, "alpha"), // ~900 chars
	"",
	para(150, "beta"), // another ~750
	"",
	"<!-- page 3 -->",
	para(20, "gamma"),
	"",
	"# Semaphor",
	"",
	"Zähler und wait.",
].join("\n");

describe("chunkDocument", () => {
	const sections = parseSections(DOC);
	const units = chunkDocument(DOC, sections);

	it("splits long sections at paragraph boundaries under the size cap, never across sections", () => {
		assert.ok(units.every((u) => u.text.length <= 1300));
		const bySection = new Set(units.map((u) => u.sectionId));
		assert.equal(bySection.size, sections.length);
		const details = units.filter((u) => u.headingPath.join(">") === "Mutex>Details");
		assert.ok(details.length >= 2, "the 1,700-char section became several units");
		assert.ok(details.every((u) => u.sectionId === details[0]!.sectionId));
	});

	it("keeps page ranges and offsets into the stored markdown", () => {
		const details = units.filter((u) => u.headingPath.join(">") === "Mutex>Details");
		assert.equal(details[0]!.pageFrom, 2);
		assert.equal(details.at(-1)!.pageTo, 3, "the last unit runs into page 3");
		for (const u of units) {
			assert.ok(DOC.slice(u.start, u.end).includes(u.text.slice(0, 12)), "offsets point at the unit's text");
		}
		const sem = units.find((u) => u.headingPath[0] === "Semaphor")!;
		assert.deepEqual([sem.pageFrom, sem.pageTo], [3, 3]);
		assert.ok(!units.some((u) => u.text.includes("<!-- page")), "marker lines are not indexed text");
	});

	it("a document without page markers has no pages on its units", () => {
		const plain = "# A\n\ntext one\n\n# B\n\ntext two";
		const u = chunkDocument(plain, parseSections(plain));
		assert.equal(u.length, 2);
		assert.ok(u.every((x) => x.pageFrom === undefined));
	});
});

describe("snippetAround", () => {
	it("returns about 300 plain chars around the best match", () => {
		const text = `${para(200, "füllung")} Der Semaphor zählt freie Plätze. ${para(200, "ende")}`;
		const s = snippetAround(text, tokenize("Semaphor Plätze"));
		assert.ok(s.includes("Semaphor zählt freie Plätze"));
		assert.ok(s.length < 340 && s.startsWith("…") && s.endsWith("…"));
		assert.ok(!/[*`#]|<!--/.test(snippetAround("## **Titel** `code`\n<!-- page 4 -->\nText", [])));
	});
});

describe("filters", () => {
	it("topics match folded, by equality or containment; documents by id or title part", () => {
		assert.ok(topicMatches(["Semaphoren", "Mutex"], "semaphore"));
		assert.ok(topicMatches(["Betriebssysteme"], "betriebssystem"));
		assert.ok(!topicMatches(["Mutex"], "Graphen"));
		const doc = { id: "doc_aaaaaaaaaaaa", title: "Übungsblatt 8: Semaphoren" };
		assert.ok(documentMatches(doc, "doc_aaaaaaaaaaaa"));
		assert.ok(documentMatches(doc, "uebungsblatt 8"));
		assert.ok(!documentMatches(doc, "blatt 9"));
	});
});

describe("sliceDocument", () => {
	const doc = { id: "doc_aaaaaaaaaaaa", title: "T", sections: parseSections(DOC) };

	it("without a selector it lists the section outline", () => {
		const r = sliceDocument(doc, DOC);
		assert.ok(r.ok && r.kind === "outline");
		assert.match(r.ok ? r.text : "", /^s1 · Mutex · p\.1/);
		assert.match(r.ok ? r.text : "", /Mutex > Details · p\.2-3/);
	});

	it("a section is its exact stored text, with its page marker when it starts mid-page", () => {
		const r = sliceDocument(doc, DOC, { section: "s2" });
		assert.ok(r.ok);
		const s2 = doc.sections[1]!;
		assert.equal(r.ok && r.text, `<!-- page 2 -->\n${DOC.slice(s2.start, s2.end)}`);
		assert.ok(r.ok && r.text.includes("<!-- page 3 -->"), "inner markers stay");
	});

	it("a page range is the exact slice from the first marker to the next one", () => {
		const r = sliceDocument(doc, DOC, { pages: "2-3" });
		assert.ok(r.ok);
		assert.ok(r.ok && r.text.startsWith("<!-- page 2 -->") && r.text.includes("<!-- page 3 -->") && r.text.includes("Zähler und wait."));
		assert.ok(r.ok && !r.text.includes("Intro zum Mutex"));
		const one = sliceDocument(doc, DOC, { pages: "1" });
		assert.ok(one.ok && one.text.includes("Intro zum Mutex") && !one.text.includes("alpha"));
	});

	it("caps long reads and continues at the given offset without losing a character", () => {
		const first = sliceDocument(doc, DOC, { pages: "2-3" }, 400);
		assert.ok(first.ok && first.truncated && first.nextOffset !== undefined && first.text.length <= 400);
		const parts = [first.ok ? first.text : ""];
		let next = first.ok ? first.nextOffset : undefined;
		while (next !== undefined) {
			const more = sliceDocument(doc, DOC, { pages: "2-3", offset: next }, 400);
			assert.ok(more.ok);
			parts.push(more.text);
			next = more.truncated ? more.nextOffset : undefined;
		}
		assert.equal(parts.join(""), (sliceDocument(doc, DOC, { pages: "2-3" }, 1e9) as { text: string }).text);
	});

	it("refuses clearly: unknown section, bad or absent pages, both selectors", () => {
		assert.match((sliceDocument(doc, DOC, { section: "s9" }) as { error: string }).error, /No section "s9"/);
		assert.match((sliceDocument(doc, DOC, { pages: "9" }) as { error: string }).error, /pages 1-3/);
		assert.match((sliceDocument(doc, DOC, { pages: "x" }) as { error: string }).error, /must look like/);
		assert.match((sliceDocument(doc, DOC, { section: "s1", pages: "1" }) as { error: string }).error, /not both/);
		const plain = "# A\n\ntext";
		assert.match((sliceDocument({ ...doc, sections: parseSections(plain) }, plain, { pages: "1" }) as { error: string }).error, /no page markers/);
	});
});
