/**
 * The LearnerStore adapter: the attribution ledger, data/learner/attributions.jsonl.
 * Append-only and the sole writer. Reads never throw and never create
 * anything (the golden data dir stays byte-identical); a torn or foreign line
 * is skipped. The directory is created by the first append only.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { AttributionRow } from "../core/contracts/learner.ts";
import type { LearnerStore } from "../core/ports.ts";

const ledger = () => path.join(PATHS.learner, "attributions.jsonl");

function isRow(v: unknown): v is AttributionRow {
	const r = v as AttributionRow | null;
	return (
		!!r &&
		typeof r.chatId === "string" &&
		typeof r.toolCallId === "string" &&
		typeof r.at === "string" &&
		Array.isArray(r.conceptIds) &&
		r.conceptIds.every((id) => typeof id === "string")
	);
}

export const learnerStore: LearnerStore = {
	appendAttribution(row) {
		fs.mkdirSync(PATHS.learner, { recursive: true });
		fs.appendFileSync(ledger(), `${JSON.stringify(row)}\n`, "utf-8");
	},
	readAttributions() {
		let text: string;
		try {
			text = fs.readFileSync(ledger(), "utf-8");
		} catch {
			return [];
		}
		const rows: AttributionRow[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isRow(parsed)) rows.push(parsed);
			} catch {
				/* a torn line: skip it */
			}
		}
		return rows;
	},
};
