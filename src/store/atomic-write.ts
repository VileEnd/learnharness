/**
 * Crash-safe file replacement for the store adapters (ported from upstream
 * 5a7ec1b, without its Windows-only code).
 *
 * writeFileAtomicSync(file, data) writes a uniquely named temp beside the
 * target, fsyncs it, and renames it over the target. Readers see the old
 * bytes or the complete new bytes. Callers keep building the exact bytes and
 * keep their own mkdirSync.
 *
 *   writeFileAtomicSync(file, JSON.stringify(record, null, "\t"));
 *   writeFileAtomicSync(AUTH_FILE, text, { mode: 0o600 }); // secrets
 *   removeLeftoverTemps(file); // after deleting `file`
 *
 * Limits:
 *  - The folder is not fsynced: a power loss right after creating a brand-new
 *    file can lose that file, never corrupt an existing one.
 *  - No locking: two writers of one file still race, and the last one wins.
 *  - Crashes can leave `<file>.tmp-<uuid>` beside the target. Store listings
 *    only read names with their own extension, so they skip it.
 *  - New files get `mode` (default 0o666 minus umask), not the old file's.
 */

import fs from "node:fs"; // default import on purpose: tests patch fs.renameSync on this object, namespace imports would not see it
import path from "node:path";
import { randomUUID } from "node:crypto";

const TEMP_MARKER = ".tmp-";

/** Replace `file` with `data` (strings are written as UTF-8). Throws on
 *  failure, with the old file untouched and the temp removed. */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, options?: { mode?: number }): void {
	const tmp = `${file}${TEMP_MARKER}${randomUUID()}`;
	try {
		const fd = fs.openSync(tmp, "wx", options?.mode ?? 0o666);
		try {
			if (options?.mode !== undefined) fs.fchmodSync(fd, options.mode); // umask may have cleared bits of the create mode
			if (typeof data === "string") fs.writeFileSync(fd, data, "utf-8");
			else fs.writeFileSync(fd, data);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file); // `file` exactly as given: test fault hooks match on it
	} catch (error) {
		removeTemp(tmp); // the target was not touched
		throw error;
	}
}

/** Delete temp files that crashes left beside `file`. Call it after deleting `file`,
 *  or leftovers would keep the deleted record's newest bytes on disk. Only names
 *  of the exact form `<basename>.tmp-<anything>` go, so no record can match. */
export function removeLeftoverTemps(file: string): void {
	const prefix = `${path.basename(file)}${TEMP_MARKER}`;
	const dir = path.dirname(file);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (error) {
		// No folder means no leftovers. Anything else is reported, not thrown:
		// the record itself is already deleted.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[store] could not look for temp files beside ${file}:`, error);
		return;
	}
	for (const name of names) if (name.startsWith(prefix)) removeTemp(path.join(dir, name));
}

function removeTemp(tmp: string): void {
	try {
		fs.unlinkSync(tmp);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[store] could not remove temp file ${tmp}:`, error); // harmless: listings skip it
	}
}
