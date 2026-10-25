/**
 * The OkfBundleStore adapter: the generated OKF library under PATHS.okf
 * (LH_LIBRARY_DIR, default data/okf). The only writer of that tree. The
 * rebuild writes into `<root>.tmp-<pid>-<n>`, moves the old tree aside, renames
 * the new one into place, then removes the old one, so a concurrent reader
 * (the agents' rooted file tools) never sees a half-written bundle. Nothing
 * here runs on construction: no mkdir, no read, no migration.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { OkfFile } from "../core/contracts/okf.ts";
import type { OkfBundleStore } from "../core/ports.ts";

/** The stamp lives BESIDE the bundle (`<root>.stamp`), never inside it: the agents browse the root. */
const stampFile = () => `${path.resolve(PATHS.okf)}.stamp`;
let counter = 0;

function safeJoin(root: string, rel: string): string {
	const abs = path.resolve(root, rel);
	if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`bundle path escapes the root: ${rel}`);
	return abs;
}

export const okfBundleStore: OkfBundleStore = {
	replaceAll(files) {
		const root = path.resolve(PATHS.okf);
		const id = `${process.pid}-${++counter}`;
		const tmp = `${root}.tmp-${id}`;
		const old = `${root}.old-${id}`;
		fs.mkdirSync(path.dirname(root), { recursive: true });
		fs.rmSync(tmp, { recursive: true, force: true });
		try {
			fs.mkdirSync(tmp, { recursive: true });
			for (const f of files as OkfFile[]) {
				const abs = safeJoin(tmp, f.path);
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, f.content);
			}
		} catch (err) {
			fs.rmSync(tmp, { recursive: true, force: true });
			throw err;
		}
		const hadOld = fs.existsSync(root);
		if (hadOld) fs.renameSync(root, old);
		try {
			fs.renameSync(tmp, root);
		} catch (err) {
			if (hadOld) fs.renameSync(old, root); // put the previous bundle back
			fs.rmSync(tmp, { recursive: true, force: true });
			throw err;
		}
		if (hadOld) fs.rmSync(old, { recursive: true, force: true });
	},
	readStamp() {
		try {
			if (!fs.existsSync(PATHS.okf)) return null; // bundle gone: a leftover stamp must not suppress the rebuild
			return fs.readFileSync(stampFile(), "utf-8");
		} catch {
			return null;
		}
	},
	writeStamp(stamp) {
		const file = stampFile();
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, stamp);
		fs.renameSync(tmp, file);
	},
};
