import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Shared plumbing for the learner-filesystem tools (ls / find / grep) —
 * sources v1 (2026-09-19): the agent locates and reads the learner's files
 * itself, so paths need no UI affordance (user decision: no attachments —
 * the learner references files in messages; the agent finds them).
 *
 * Safety posture (user-locked): READ-ONLY by construction — no shell-out,
 * no user-controlled process args, no mutation APIs anywhere here. Paths
 * resolve against the library root only (resolveLibraryPath): no absolute
 * paths, no `..`, no symlink escapes.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/{ls,find,grep}.js): the
 * schemas, descriptions, output formats, and truncation notices are copied
 * verbatim except where semantics differ (home default, no .gitignore —
 * replaced by hard noise exclusions).
 */

/** 50KB — pi's DEFAULT_MAX_BYTES, the output ceiling for every fs tool. */
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** pi's grep line-truncation length (GREP_MAX_LINE_LENGTH). */
export const GREP_MAX_LINE_LENGTH = 500;
/** Wall-clock budget for tree walks (find/grep over a whole home dir). */
export const WALK_TIMEOUT_MS = 10_000;

/**
 * Directory names never entered during walks. node_modules/.git mirror pi's
 * fd/rg defaults; Library/.Trash are the home-root noise the user approved
 * (2026-09-19) — caches, app support, and the trash live under them.
 * Explicit paths (ls/read of ~/Library/…) are NOT filtered — only walks.
 */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "Library", ".Trash"]);

export const LIBRARY_MISSING_MESSAGE =
	"The library is empty right now (it is being built). Try search_documents.";
export const LIBRARY_ESCAPE_MESSAGE =
	"Paths are relative to the library root (start with index.md); absolute paths and '..' are not allowed.";

/** Options shared by the library tool factories. `beforeAccess` runs before
 *  every call (the freshness hook; unused until the bundle service wires it). */
export interface LibraryToolOptions {
	beforeAccess?: () => Promise<void>;
}

export type LibraryPath = { ok: true; abs: string } | { ok: false; error: string };

/**
 * Resolve a tool path argument against the library root. Relative paths
 * only: absolute paths, `..` traversal and symlinks that leave the root are
 * refused. A missing root answers with the "being built" copy and is never
 * created. A non-existent target inside the root resolves lexically so the
 * caller can report "not found".
 */
export async function resolveLibraryPath(root: string, p?: string): Promise<LibraryPath> {
	const escape: LibraryPath = { ok: false, error: LIBRARY_ESCAPE_MESSAGE };
	const raw = p ?? "";
	if (raw.includes("\0")) return escape;
	if (path.isAbsolute(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) return escape;
	const rel = path.normalize(raw === "" ? "." : raw);
	if (rel === ".." || rel.startsWith(`..${path.sep}`)) return escape;

	let rootReal: string;
	try {
		rootReal = await fs.realpath(root);
		if (!(await fs.stat(rootReal)).isDirectory()) return { ok: false, error: LIBRARY_MISSING_MESSAGE };
	} catch {
		return { ok: false, error: LIBRARY_MISSING_MESSAGE };
	}
	const inside = (candidate: string) =>
		candidate === rootReal || candidate.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);

	const lexical = path.join(rootReal, rel);
	try {
		const real = await fs.realpath(lexical);
		return inside(real) ? { ok: true, abs: real } : escape;
	} catch {
		// Not found (or a dangling link): check the nearest existing ancestor
		// stays inside, then hand back the lexical path.
		let ancestor = path.dirname(lexical);
		for (;;) {
			try {
				const real = await fs.realpath(ancestor);
				if (!inside(real)) return escape;
				break;
			} catch {
				const up = path.dirname(ancestor);
				if (up === ancestor) return escape;
				ancestor = up;
			}
		}
		return { ok: true, abs: lexical };
	}
}

/** Resolve or throw the refusal copy as an error (the tool result the model sees). */
export async function requireLibraryPath(root: string, p?: string): Promise<string> {
	const r = await resolveLibraryPath(root, p);
	if (!r.ok) throw new Error(r.error);
	return r.abs;
}

/** pi's formatSize idiom (50KB prints as "50.0KB"). */
export function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Cap output to MAX_OUTPUT_BYTES on whole lines, pi's truncateHead idiom. */
export function capOutput(lines: string[]): { content: string; truncated: boolean } {
	const out: string[] = [];
	for (const line of lines) {
		const candidate = [...out, line].join("\n");
		if (Buffer.byteLength(candidate, "utf-8") > MAX_OUTPUT_BYTES) {
			return { content: out.join("\n"), truncated: true };
		}
		out.push(line);
	}
	return { content: out.join("\n"), truncated: false };
}

/** Expand top-level brace alternatives: '*.{ts,tsx}' → ['*.ts', '*.tsx'].
 *  Nested braces are out of scope (pi's fd handles them; models rarely
 *  emit them — a non-expanding literal match is the graceful fallback). */
export function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const close = pattern.indexOf("}", open);
	if (close === -1) return [pattern];
	const before = pattern.slice(0, open);
	const after = pattern.slice(close + 1);
	const alts: string[] = [];
	for (const alt of pattern.slice(open + 1, close).split(",")) {
		alts.push(...expandBraces(before + alt + after));
	}
	return alts;
}

/** Glob → anchored RegExp. '*' stays within a segment, '**' crosses '/',
 *  '?' is one char, everything else literal. */
export function globToRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += "[\\s\\S]*";
				i++;
				if (glob[i + 1] === "/") i++; // '**/' also eats the slash
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/**
 * pi/fd's matching rule: a pattern with no slash matches against the
 * BASENAME at any depth; one with a slash matches the relative path, with
 * an implied leading "**-slash" prefix unless it is itself anchored (see
 * the code below — the literal sequence cannot appear in this comment
 * because it terminates block comments).
 */
export function matchGlob(relativePath: string, pattern: string): boolean {
	const posix = relativePath.split(path.sep).join("/");
	const basename = posix.split("/").pop() ?? posix;
	for (const alt of expandBraces(pattern)) {
		if (!alt.includes("/")) {
			if (globToRegex(alt).test(basename)) return true;
		} else {
			let effective = alt;
			if (!effective.startsWith("/") && !effective.startsWith("**/") && effective !== "**") {
				effective = `**/${effective}`;
			}
			if (effective.startsWith("/")) effective = effective.slice(1);
			if (globToRegex(effective).test(posix)) return true;
		}
	}
	return false;
}

/**
 * Depth-first walk under `root`, never entering EXCLUDED_DIR_NAMES.
 * `visit` receives absolute file paths; returning true STOPS the walk
 * (find's result limit). The deadline bounds a home-dir walk to
 * WALK_TIMEOUT_MS — partial results are the graceful degradation.
 */
export async function walkFiles(
	root: string,
	visit: (filePath: string) => boolean | Promise<boolean>,
	signal?: AbortSignal,
): Promise<{ timedOut: boolean; aborted: boolean }> {
	const deadline = Date.now() + WALK_TIMEOUT_MS;
	let timedOut = false;
	let aborted = false;
	if (signal?.aborted) return { timedOut: false, aborted: true };

	const walkDir = async (dir: string): Promise<boolean> => {
		if (Date.now() > deadline) {
			timedOut = true;
			return true; // stop
		}
		if (signal?.aborted) {
			aborted = true;
			return true; // stop — abort yields partial results, not a throw
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return false; // unreadable dir (permissions): skip, keep walking
		}
		for (const entry of entries) {
			if (Date.now() > deadline) {
				timedOut = true;
				return true;
			}
			if (signal?.aborted) {
				aborted = true;
				return true;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
				if (await walkDir(full)) return true;
			} else if (entry.isFile()) {
				if (await visit(full)) return true;
			}
			// symlinks/other: not followed (pi's fd doesn't follow either)
		}
		return false;
	};

	await walkDir(root);
	return { timedOut, aborted };
}

/** True if the first 8KB chunk contains a NUL byte — pi/rg's binary skip. */
export async function isBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buf, 0, 8192, 0);
		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

/** pi's GREP_MAX_LINE_LENGTH line truncation (no mid-word care, hard cap). */
export function truncateGrepLine(line: string): { text: string; wasTruncated: boolean } {
	if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}… [truncated]`, wasTruncated: true };
}
