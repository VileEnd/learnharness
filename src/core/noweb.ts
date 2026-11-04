/**
 * Noweb to markdown: a literate source file (.nw, LaTeX prose + named code
 * chunks) as the library's indexable text. Deterministic, no model involved.
 *
 * The library finds a document's structure through markdown headings and fenced
 * code (core/documents.ts parseSections), so that is what comes out: LaTeX
 * sectioning becomes headings, code chunks and verbatim environments become
 * fences (a `#include` is then never mistaken for prose), and chunk names and
 * `<<references>>` survive. The document's own simple macros are expanded, so a
 * `\hex{C0000000}` reads and searches as `0xC0000000`. Formulas and any LaTeX
 * not handled here stay as written: the text stays complete, only less tidy.
 */

const CHUNK_START = /^<<(.+)>>=[ \t]*$/;
const CHUNK_END = /^@(?:[ \t]+(.*))?$/;
const VERBATIM_BEGIN = /^\s*\\begin\{(verbatim|Verbatim|lstlisting)\}/;

/** A noweb source, by the extension it arrived under. */
export function isNowebFile(name: string): boolean {
	return /\.nw$/i.test(name);
}

/** Is this still noweb source (a chunk definition outside any code fence)? The
 *  converter fences every chunk and labels it in a code span, so its output
 *  never answers yes. */
export function isRawNoweb(text: string): boolean {
	const outsideFences = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
	return /^<<.+>>=[ \t]*$/m.test(outsideFences);
}

// ─── LaTeX commands ──────────────────────────────────────────────────────────

interface Rule {
	args: number;
	/** Accepts a `[short form]` before its arguments (ignored). */
	optional?: boolean;
	to(args: string[]): string;
}
type Rules = ReadonlyMap<string, Rule>;

/** The content of the `{...}` opening at `open`, and where it ends. */
function readGroup(text: string, open: number): { content: string; end: number } | null {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") i++;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return { content: text.slice(open + 1, i), end: i + 1 };
	}
	return null;
}

/** Apply `rules` to every command in `text`, arguments first. A command whose
 *  arguments cannot be read stays as written. */
function rewrite(text: string, rules: Rules): string {
	const command = /(?<!\\)\\([a-zA-Z]+)\*?/g;
	let out = "";
	let from = 0;
	for (let m = command.exec(text); m; m = command.exec(text)) {
		const rule = rules.get(m[1]!);
		if (!rule) continue;
		let pos = command.lastIndex;
		if (rule.optional && text[pos] === "[") {
			const close = text.indexOf("]", pos);
			if (close !== -1) pos = close + 1;
		}
		const args: string[] = [];
		while (args.length < rule.args && text[pos] === "{") {
			const group = readGroup(text, pos);
			if (!group) break;
			args.push(rewrite(group.content, rules));
			pos = group.end;
		}
		if (args.length < rule.args) continue;
		if (rule.args === 0 && text.startsWith("{}", pos)) pos += 2;
		out += text.slice(from, m.index) + rule.to(args);
		from = pos;
		command.lastIndex = pos;
	}
	return out + text.slice(from);
}

const stripComments = (text: string): string => text.replace(/^[ \t]*%.*\n?/gm, "").replace(/(?<!\\)%.*$/gm, "");

/** Every `\newcommand` in `text` (comments already stripped). */
function definitionsIn(text: string) {
	const definition = /\\(?:re)?newcommand\*?\s*\{?\\([a-zA-Z]+)\}?\s*(?:\[(\d)\])?\s*(\[[^\]]*\])?\s*(?=\{)/g;
	const found: { name: string; args: number; hasDefault: boolean; body: string; start: number; end: number }[] = [];
	for (let m = definition.exec(text); m; m = definition.exec(text)) {
		const body = readGroup(text, definition.lastIndex);
		if (!body) continue;
		found.push({ name: m[1]!, args: Number(m[2] ?? 0), hasDefault: m[3] !== undefined, body: body.content, start: m.index, end: body.end });
		definition.lastIndex = body.end;
	}
	return found;
}

/** The document's own macros, as rules that expand them. One with an optional
 *  argument takes `[...]` at its call sites, which the rules do not read. */
function macrosOf(source: string): Rules {
	const macros = new Map<string, Rule>();
	for (const { name, args, hasDefault, body } of definitionsIn(stripComments(source))) {
		if (hasDefault) continue;
		macros.set(name, { args, to: (given) => body.replace(/#(\d)/g, (_, n: string) => given[Number(n) - 1] ?? "") });
	}
	return macros;
}

function withoutDefinitions(text: string): string {
	let out = "";
	let from = 0;
	for (const { start, end } of definitionsIn(text)) {
		out += text.slice(from, start);
		from = end;
	}
	return out + text.slice(from);
}

/** Macros use each other; the bound also ends one that expands into itself. */
const MAX_EXPANSION_DEPTH = 8;

function expandMacros(text: string, macros: Rules): string {
	let current = text;
	for (let i = 0; i < MAX_EXPANSION_DEPTH; i++) {
		const next = rewrite(current, macros);
		if (next === current) break;
		current = next;
	}
	return current;
}

const LEVELS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph"];
/** Marks a heading until the whole document shows which levels it uses. */
const HEADING_MARK = "\u0003";
const HEADING = new RegExp(`${HEADING_MARK}(\\d)${HEADING_MARK}(.*)`, "g");
const SPAN = /\u0001(\d+)\u0002/g;

const LIST_MARKER = String.raw`\\(?:begin|end)\{(?:itemize|enumerate|description)\}(?:\[[^\]]*\])?`;

const unescapeLatex = (text: string): string => text.replace(/\\([_%&])/g, "$1");

function convertProse(source: string, macros: Rules): string {
	// Inline code first: nothing below may touch it (`[[%eax]]` is not a comment).
	const spans: string[] = [];
	const span = (code: string): string => `\u0001${spans.push(code) - 1}\u0002`;
	const plain = (text: string): string => text.replace(SPAN, (_, n: string) => spans[Number(n)]!);

	const protectedText = source
		.replace(/\\(?:verb|path)\*?([^a-zA-Z\s*{])(.*?)\1/g, (_, _d: string, code: string) => span(code))
		.replace(/\\(?:path|url)\{([^{}]*)\}/g, (_, code: string) => span(code))
		.replace(/\[\[(<<.+?>>|.+?)\]\](?!\])/g, (_, code: string) => span(code));

	const codeSpan = (text: string): string => span(plain(text).replace(/\*\*(.*?)\*\*/g, "$1"));

	const rules = new Map<string, Rule>();
	const add = (names: string, rule: Rule) => {
		for (const name of names.split(" ")) rules.set(name, rule);
	};
	// A margin note repeats a keyword of the text beside it.
	add("index label marginnote vspace hspace enlargethispage color", { args: 1, to: () => "" });
	add("noindent pagebreak newpage clearpage cleardoublepage centering small footnotesize normalfont smallskip medskip bigskip", { args: 0, to: () => "" });
	add("textsc textsl footnote caption", { args: 1, to: ([x]) => x! });
	add("emph textit", { args: 1, to: ([x]) => `*${x}*` });
	add("textbf", { args: 1, to: ([x]) => `**${x}**` });
	add("texttt", { args: 1, to: ([x]) => codeSpan(unescapeLatex(x!)) });
	LEVELS.forEach((name, level) => {
		add(name, {
			args: 1,
			optional: true,
			to: ([title]) => `\n\n${HEADING_MARK}${level}${HEADING_MARK}${title!.replace(/\s+/g, " ").trim()}\n\n`,
		});
	});

	const converted = unescapeLatex(rewrite(expandMacros(withoutDefinitions(stripComments(protectedText)), macros), rules))
		.replace(/\{\\tt\s+([^{}]*)\}/g, (_, code: string) => codeSpan(code))
		.replace(/\{\\(?:em|it)\s+([^{}]*)\}/g, "*$1*")
		.replace(/\{\\bf\s+([^{}]*)\}/g, "**$1**")
		.replace(/\\(?:l?dots)\b(?:\{\})?/g, "…")
		.replace(/\\,/g, " ")
		.replace(/``/g, "“")
		.replace(/''/g, "”")
		.replace(new RegExp(`^[ \\t]*${LIST_MARKER}[ \\t]*\\n`, "gm"), "")
		.replace(new RegExp(`[ \\t]*${LIST_MARKER}[ \\t]*`, "g"), "")
		.replace(/\\itemsep[-=.\da-z]*/g, "")
		.replace(/^[ \t]*\\item(?![a-zA-Z])(?:\[([^\]]*)\])?[ \t]*/gm, (_, label: string | undefined) => (label ? `- **${label}** ` : "- "))
		.replace(/^[ \t]+/gm, "") // markdown reads an indented line as code
		.replace(/^[{}][ \t]*$\n?/gm, "");

	return converted.replace(SPAN, (_, n: string) => {
		const code = spans[Number(n)]!;
		return code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
	});
}

const fenced = (lines: readonly string[]): string => {
	const fence = lines.some((line) => /^\s{0,3}```/.test(line)) ? "~~~" : "```";
	return [fence, ...lines, fence].join("\n");
};

/** Headings get their depth once the whole document is known: a lone `\part`
 *  (a title page) is no level of its own, and the top level in use is `#`, which
 *  is where extraction's chunks break. */
function settleHeadings(text: string): string {
	const used = new Set<number>();
	let parts = 0;
	for (const m of text.matchAll(HEADING)) {
		const level = Number(m[1]);
		if (level === 0) parts++;
		else used.add(level);
	}
	if (parts > 1) used.add(0);
	const ranks = [...used].sort((a, b) => a - b);
	return text.replace(HEADING, (_, level: string, title: string) => {
		if (title === "") return "";
		const rank = ranks.indexOf(Number(level));
		return rank === -1 ? `**${title}**` : `${"#".repeat(Math.min(rank + 1, 6))} ${title}`;
	});
}

/** The noweb source as markdown. Run it only on source (isRawNoweb): its output
 *  is plain markdown and has no chunks left to find. */
export function nowebToMarkdown(source: string): string {
	const text = source.replace(/\r\n/g, "\n").replace(/[\u0001-\u0003]/g, "");
	const begin = /^\\begin\{document\}.*$/m.exec(text);
	const afterBegin = begin ? begin.index + begin[0].length : 0;
	// The last one: code or a verbatim block may well mention the command.
	const end = text.lastIndexOf("\\end{document}");
	const macros = macrosOf(text);

	const pieces: string[] = [];
	let prose: string[] = [];
	const flushProse = () => {
		if (prose.length > 0) pieces.push(convertProse(prose.join("\n"), macros));
		prose = [];
	};
	let code: string[] | null = null;
	let chunk: string | null = null;
	let verbatimEnd: RegExp | null = null;
	const closeCode = () => {
		if (code === null) return;
		pieces.push(`${chunk === null ? "" : `\`<<${chunk}>>=\`\n`}${fenced(code)}`);
		code = null;
		chunk = null;
	};

	for (const line of text.slice(afterBegin, end < afterBegin ? undefined : end).split("\n")) {
		if (verbatimEnd) {
			if (verbatimEnd.test(line)) {
				closeCode();
				verbatimEnd = null;
			} else code!.push(line);
			continue;
		}
		const start = CHUNK_START.exec(line);
		if (start) {
			flushProse();
			closeCode();
			code = [];
			chunk = start[1]!;
			continue;
		}
		if (code !== null) {
			const close = CHUNK_END.exec(line);
			if (close) {
				closeCode();
				if (close[1]) prose.push(close[1]);
			} else code.push(line.replace(/@(<<|>>)/g, "$1").replace(/^@@/, "@"));
			continue;
		}
		const verbatim = VERBATIM_BEGIN.exec(line);
		if (verbatim) {
			flushProse();
			code = [];
			verbatimEnd = new RegExp(`^\\s*\\\\end\\{${verbatim[1]}\\}`);
			continue;
		}
		const close = CHUNK_END.exec(line);
		prose.push(close ? (close[1] ?? "") : line);
	}
	flushProse();
	closeCode();

	return `${settleHeadings(pieces.join("\n\n"))
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}
