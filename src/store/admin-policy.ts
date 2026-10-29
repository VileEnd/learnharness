/**
 * The AdminPolicyStore adapter: <globalDataRoot()>/admin.json, written
 * tmp + rename at mode 0600. Absent or invalid reads as null.
 * Implements core/ports.ts AdminPolicyStore.
 */

import fs from "node:fs";
import path from "node:path";
import { globalDataRoot } from "../../config.ts";
import type { AdminPolicyStore } from "../core/ports.ts";
import type { AdminPolicy } from "../core/contracts/admin.ts";

const file = () => path.join(globalDataRoot(), "admin.json");

export const adminPolicyStore: AdminPolicyStore = {
	readPolicy() {
		try {
			const raw = JSON.parse(fs.readFileSync(file(), "utf-8")) as Partial<AdminPolicy> | null;
			if (!raw || raw.version !== 1 || !raw.newUserDefaults || typeof raw.users !== "object" || !raw.users) return null;
			return raw as AdminPolicy;
		} catch {
			return null;
		}
	},
	writePolicy(p) {
		const f = file();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		const tmp = `${f}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(p, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, f);
	},
};
