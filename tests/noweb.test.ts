/**
 * The noweb converter: literate source (.nw, LaTeX prose + code chunks) to the
 * markdown the library indexes. Pins what indexing depends on: real headings
 * from the LaTeX structure, code kept whole and fenced, and running it twice
 * changing nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSections } from "../src/core/documents.ts";
import { isNowebFile, isRawNoweb, nowebToMarkdown } from "../src/core/noweb.ts";

const doc = (body: string, preamble = "") => `\\documentclass{book}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\nafter the end\n`;

describe("nowebToMarkdown", () => {
	it("keeps only the document body", () => {
		const out = nowebToMarkdown(doc("Hello.", "\\usepackage{noweb}"));
		assert.ok(out.includes("Hello."));
		assert.ok(!out.includes("usepackage"));
		assert.ok(!out.includes("after the end"));
	});

	it("a mention of \\end{document} in code does not cut the rest off", () => {
		const out = nowebToMarkdown(doc("<<generator>>=\nputs(\"\\\\end{document}\");\n\\end{document}\n@\nProse after it."));
		assert.ok(out.includes("Prose after it."), out);
		assert.ok(out.includes("\\end{document}\n```"), "and the code keeps its line");
	});

	it("reads a fragment with no document environment as all body", () => {
		assert.ok(nowebToMarkdown("\\section{Intro}\nHello.").startsWith("# Intro"));
	});

	it("turns the LaTeX structure into the section tree", () => {
		const out = nowebToMarkdown(doc("\\chapter{Memory}\nA\n\\section[Short]{Paging}\nB\n\\subsection*{Page tables}\nC\n\\subsubsection{Entries}\nD"));
		assert.deepEqual(
			parseSections(out).map((s) => s.headingPath),
			[["Memory"], ["Memory", "Paging"], ["Memory", "Paging", "Page tables"], ["Memory", "Paging", "Page tables", "Entries"]],
		);
	});

	it("a lone \\part is not a top level, so chunks still break at chapters", () => {
		const out = nowebToMarkdown(doc("\\part*{The Book}\n\\chapter{One}\nA\n\\chapter{Two}\nB"));
		assert.deepEqual(parseSections(out).map((s) => s.headingPath[0]).filter(Boolean), ["One", "Two"]);
	});

	it("several parts become the top level", () => {
		const out = nowebToMarkdown(doc("\\part{A}\n\\chapter{One}\nx\n\\part{B}\n\\chapter{Two}\ny"));
		assert.deepEqual(parseSections(out).map((s) => s.headingPath), [["A"], ["A", "One"], ["B"], ["B", "Two"]]);
	});

	it("fences a code chunk whole, keeping its name and its references", () => {
		const out = nowebToMarkdown(doc("Prose.\n<<kernel.c>>=\n#include <stdio.h>\n# not a heading\n<<constants>>\nint main;\n@ %def main\nMore prose."));
		assert.ok(out.includes("`<<kernel.c>>=`\n```\n#include <stdio.h>\n# not a heading\n<<constants>>\nint main;\n```"));
		assert.ok(out.includes("More prose."));
		assert.ok(!out.includes("%def"));
		assert.equal(parseSections(out).length, 1, "code lines never become headings");
	});

	it("text after a closing @ stays prose, and a new chunk closes the open one", () => {
		const out = nowebToMarkdown(doc("<<a>>=\none\n<<b>>=\ntwo\n@ which is short."));
		assert.ok(out.includes("`<<a>>=`\n```\none\n```"));
		assert.ok(out.includes("`<<b>>=`\n```\ntwo\n```"));
		assert.ok(out.includes("which is short."));
	});

	it("unescapes noweb's @<< and @@ in code", () => {
		const out = nowebToMarkdown(doc("<<a>>=\nx = @<<y@>>;\n@@ start\n@"));
		assert.ok(out.includes("x = <<y>>;\n@ start\n```"));
	});

	it("uses a tilde fence when the code itself contains backtick fences", () => {
		const out = nowebToMarkdown(doc("<<a>>=\n```\ninner\n```\n@"));
		assert.ok(out.includes("~~~\n```\ninner\n```\n~~~"));
		assert.deepEqual(parseSections(`${out}\n# After`).map((s) => s.headingPath[0]).at(-1), "After");
	});

	it("fences verbatim environments, so a shell comment is not a heading", () => {
		const out = nowebToMarkdown(doc("\\begin{Verbatim}[fontsize=\\small]\n# bindump -r < a.img\n<<not a chunk>>=\n\\end{Verbatim}\nAfter."));
		assert.ok(out.includes("```\n# bindump -r < a.img\n<<not a chunk>>=\n```"));
		assert.equal(parseSections(out).length, 1);
		assert.ok(out.includes("After."));
	});

	it("turns inline code into code spans, protecting it from everything else", () => {
		const out = nowebToMarkdown(doc("Use [[%eax]] and \\verb|%esp\\_x| and \\path|a_b| and [[a[b[0]]]] here. % a comment"));
		assert.ok(out.includes("Use `%eax` and `%esp\\_x` and `a_b` and `a[b[0]]` here."), out);
		assert.ok(!out.includes("a comment"));
	});

	it("keeps a quoted chunk name whole, even with quoted code inside it", () => {
		const out = nowebToMarkdown(doc("See [[<<[[fork]]: copy files>>]] for that."));
		assert.ok(out.includes("See `<<[[fork]]: copy files>>` for that."), out);
	});

	it("drops comments but keeps an escaped percent", () => {
		const out = nowebToMarkdown(doc("% gone entirely\n%\\section{Old}\nAbout 50\\% done."));
		assert.ok(!out.includes("gone entirely"));
		assert.equal(parseSections(out).length, 1);
		assert.ok(out.includes("About 50% done."));
	});

	it("converts common commands, and leaves formulas and anything unknown alone", () => {
		const out = nowebToMarkdown(doc("\\emph{soft} \\textbf{hard} \\texttt{a\\_b} {\\tt c}\\index{gone}\\label{gone2}\\noindent $x_1 + \\alpha$ \\unknown{kept}"));
		assert.ok(out.includes("*soft* **hard** `a_b` `c`"), out);
		assert.ok(!out.includes("gone"));
		assert.ok(!out.includes("noindent"));
		assert.ok(out.includes("$x_1 + \\alpha$"));
		assert.ok(out.includes("\\unknown{kept}"));
	});

	it("turns lists into markdown lists", () => {
		const out = nowebToMarkdown(doc("\\begin{itemize}\n  \\item one\n  \\item[Two] two\n\\end{itemize}"));
		assert.ok(out.includes("- one\n- **Two** two"), out);
		assert.ok(!out.includes("itemize"));
	});

	it("a list marker sharing a line with text loses only the marker", () => {
		const out = nowebToMarkdown(doc("\\begin{itemize}\\item first\n\\item second \\end{itemize}\n\\begin{enumerate}[a)]\\itemsep-1pt\n\\item third\n\\end{enumerate}"));
		assert.ok(out.includes("- first\n- second"), out);
		assert.ok(out.includes("- third"), out);
		assert.ok(!/itemize|enumerate|itemsep/.test(out), out);
	});

	it("expands the document's own macros, with arguments and through each other", () => {
		const preamble = [
			"\\newcommand{\\Sys}{\\textsc{Ulix}}",
			"\\newcommand\\hex[1]{{\\tt 0x#1}}",
			"\\newcommand{\\pindex}[1]{\\index{#1}}",
			"\\newcommand{\\vindex}[1]{#1\\index{#1}}",
			"\\newcommand\\range[2]{{\\tt 0x#1}--{\\tt 0x#2}}",
			"\\newcommand{\\codesection}[1]{\\section{#1\\mark{}}}",
			"\\newcommand{\\mark}{*}",
		].join("\n");
		const out = nowebToMarkdown(doc("\\codesection{Booting \\Sys{}}\nThe \\Sys{} kernel at \\hex{C0000000} to \\range{0}{F}, a \\vindex{mutex}\\pindex{lock}.", preamble));
		assert.deepEqual(parseSections(out).map((s) => s.headingPath), [["Booting Ulix*"]]);
		assert.ok(out.includes("The Ulix kernel at `0xC0000000` to `0x0`--`0xF`, a mutex."), out);
	});

	it("does not touch a macro name that merely starts with a defined one", () => {
		const out = nowebToMarkdown(doc("\\Sysfoo{} and \\Sys{}", "\\newcommand{\\Sys}{X}"));
		assert.ok(out.includes("\\Sysfoo{} and X"), out);
	});

	it("survives a macro that expands into itself", () => {
		const out = nowebToMarkdown(doc("\\loop{}", "\\newcommand{\\loop}{\\loop{}!}"));
		assert.ok(out.includes("!"));
	});

	it("a macro defined inside the body works, and its definition is not content", () => {
		const out = nowebToMarkdown(doc("\\newcommand{\\Sys}{X}\n\\renewcommand{\\toc}[1][Contents]{\n  \\chapter*{#1}\n}\nThe \\Sys{} kernel"));
		assert.ok(out.includes("The X kernel"), out);
		assert.ok(!out.includes("newcommand"), out);
		assert.deepEqual(parseSections(out).flatMap((s) => s.headingPath), [], "the definition's \\chapter is not a heading");
	});

	it("margin notes repeat a nearby keyword, so they do not double the text", () => {
		const out = nowebToMarkdown(doc("The \\emph{bitmap}\\marginnote{bitmap} starts here.", "\\newcommand{\\marginhl}[1]{\\marginnote{#1}}"));
		assert.ok(out.includes("The *bitmap* starts here."), out);
	});

	it("no markdown emphasis inside code, and LaTeX quotes are not backticks", () => {
		const out = nowebToMarkdown(doc("\\section{The {\\tt \\textbf{main()}} Function}\n``Going where?'' and \\texttt{\\textbf{x}}"));
		assert.deepEqual(parseSections(out).map((s) => s.headingPath), [["The `main()` Function"]]);
		assert.ok(out.includes("“Going where?” and `x`"), out);
	});

	it("drops a brace left alone on its line", () => {
		const out = nowebToMarkdown(doc("{\\small\n\\begin{Verbatim}\nx\n\\end{Verbatim}\n}\nAfter."));
		assert.ok(!/^[{}]$/m.test(out), out);
	});

	it("never leaves an indented prose line, which markdown would show as code", () => {
		const out = nowebToMarkdown(doc("Para\n\n      indented prose"));
		assert.ok(out.includes("\n\nindented prose"));
	});
});

describe("telling source from converted text", () => {
	const raw = doc("\\section{A}\nProse.\n<<a>>=\ncode\n@");

	it("recognises raw noweb, and not its own output", () => {
		assert.equal(isRawNoweb(raw), true);
		assert.equal(isRawNoweb(nowebToMarkdown(raw)), false);
		assert.equal(isRawNoweb("# Plain markdown\n\ntext"), false);
	});

	it("does not take an escaped chunk line inside a converted fence for raw noweb", () => {
		const converted = nowebToMarkdown(doc("<<a>>=\n@<<b@>>=\n@"));
		assert.ok(converted.includes("<<b>>=\n```"));
		assert.equal(isRawNoweb(converted), false);
	});

	it("knows a noweb file by its extension", () => {
		assert.deepEqual(["a.nw", "B.NW", "a.md", "nw", "a.nw.md"].map(isNowebFile), [true, true, false, false, false]);
	});
});
