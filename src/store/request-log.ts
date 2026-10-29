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

export const requestLogStore: RequestLogStore = {
	append(line) {
		fs.mkdirSync(PATHS.logs, { recursive: true });
		fs.appendFileSync(file(monthKey(line.at)), `${JSON.stringify(line)}\n`, "utf-8");
	},
	readMonth(month) {
		let text: string;
		try {
			text = fs.readFileSync(file(month), "utf-8");
		} catch {
			return [];
		}
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
	},
	monthStamp(month) {
		try {
			const st = fs.statSync(file(month));
			return `${st.size}:${st.mtimeMs}`;
		} catch {
			return null;
		}
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
