/**
 * Append one JSONL record. If a crash left a torn last line (no trailing
 * newline), the record starts on a new line instead of fusing with it, so the
 * readers lose only the torn line and never the next good record. The ledgers
 * stay append-only.
 */

import fs from "node:fs";

export function appendJsonlSync(file: string, record: unknown): void {
	const fd = fs.openSync(file, "a+"); // creates the file; appends always land at the end
	try {
		const size = fs.fstatSync(fd).size;
		let prefix = "";
		if (size > 0) {
			const last = Buffer.alloc(1);
			fs.readSync(fd, last, 0, 1, size - 1);
			if (last[0] !== 0x0a) prefix = "\n";
		}
		fs.writeSync(fd, `${prefix}${JSON.stringify(record)}\n`);
	} finally {
		fs.closeSync(fd);
	}
}
