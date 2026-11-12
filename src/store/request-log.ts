/**
 * The RequestLogStore adapter: data/logs/requests-YYYY-MM.jsonl, append-only.
 * Reads never throw and never create anything (golden data stays untouched);
 * a torn or foreign line is skipped. The directory is created by the first
 * append only.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { RequestLogLine } from "../core/contracts/usage.ts";
import type { RequestLogStore } from "../core/ports.ts";
import { isUsageCategory, monthKey } from "../core/usage.ts";
import { appendJsonlSync } from "./jsonl-append.ts";

const file = (month: string) => path.join(PATHS.logs, `requests-${month}.jsonl`);
const marker = () => path.join(PATHS.logs, "backfill.done");

function isLine(v: unknown): v is RequestLogLine {
	const l = v as RequestLogLine | null;
	return (
		!!l &&
		l.v === 1 &&
		typeof l.at === "string" &&
		typeof l.purpose === "string" &&
		isUsageCategory(l.category) &&
		typeof l.provider === "string" &&
		typeof l.model === "string" &&
		typeof l.outcome === "string"
	);
}

/** The valid lines of a JSONL text; a torn or foreign line is skipped. */
function parseLines(text: string): RequestLogLine[] {
	const lines: RequestLogLine[] = [];
	for (const raw of text.split("\n")) {
		if (raw.trim() === "") continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isLine(parsed)) lines.push(parsed);
		} catch {
			/* a torn line: skip it */
		}
	}
	return lines;
}

export const requestLogStore: RequestLogStore = {
	append(line) {
		fs.mkdirSync(PATHS.logs, { recursive: true });
		appendJsonlSync(file(monthKey(line.at)), line);
	},
	readMonth(month) {
		let text: string;
		try {
			text = fs.readFileSync(file(month), "utf-8");
		} catch {
			return [];
		}
		return parseLines(text);
	},
	readMonthSince(month, cursor) {
		let st: fs.Stats;
		try {
			st = fs.statSync(file(month));
		} catch {
			return { lines: [], cursor: { identity: "", offset: 0 }, reset: true };
		}
		const identity = `${st.ino}:${st.birthtimeMs}`;
		const same = cursor !== null && cursor.identity === identity && cursor.offset <= st.size;
		const from = same ? cursor.offset : 0;
		if (same && from === st.size) return { lines: [], cursor, reset: false };
		let buf: Buffer;
		try {
			const fd = fs.openSync(file(month), "r");
			try {
				buf = Buffer.alloc(st.size - from);
				const n = fs.readSync(fd, buf, 0, buf.length, from);
				buf = buf.subarray(0, n);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return { lines: [], cursor: { identity: "", offset: 0 }, reset: true };
		}
		// Whole lines only: a line another writer is still appending is left for
		// the next read. An unterminated tail that already parses counts, as it
		// does in readMonth (a crash can leave the newline off the last record).
		const lastNewline = buf.lastIndexOf(0x0a);
		let consumed = lastNewline + 1;
		const tail = buf.subarray(consumed).toString("utf-8");
		if (tail.trim() !== "") {
			try {
				JSON.parse(tail);
				consumed = buf.length;
			} catch {
				/* still being written, or torn: not consumed */
			}
		}
		const lines = parseLines(buf.subarray(0, consumed).toString("utf-8"));
		return { lines, cursor: { identity, offset: from + consumed }, reset: !same };
	},
	months() {
		let names: string[];
		try {
			names = fs.readdirSync(PATHS.logs);
		} catch {
			return [];
		}
		return names
			.map((n) => /^requests-(\d{4}-\d{2})\.jsonl$/.exec(n)?.[1])
			.filter((m): m is string => m !== undefined)
			.sort();
	},
	backfillDone() {
		return fs.existsSync(marker());
	},
	markBackfilled() {
		fs.mkdirSync(PATHS.logs, { recursive: true });
		fs.writeFileSync(marker(), `${new Date().toISOString()}\n`, "utf-8");
	},
};
