/**
 * The AdminPolicyStore adapter: <globalDataRoot()>/admin.json, written
 * tmp + rename at mode 0600. Absent reads as null; present but invalid throws AdminPolicyCorrupt.
 * Implements core/ports.ts AdminPolicyStore.
 */

import fs from "node:fs";
import path from "node:path";
import { globalDataRoot } from "../../config.ts";
import type { AdminPolicyStore } from "../core/ports.ts";
import { AdminPolicyCorrupt, type AdminPolicy } from "../core/contracts/admin.ts";

const file = () => path.join(globalDataRoot(), "admin.json");

const isModel = (m: unknown): boolean => {
	const x = m as { provider?: unknown; id?: unknown } | null;
	return !!x && typeof x === "object" && typeof x.provider === "string" && typeof x.id === "string";
};

function isUserPolicy(v: unknown): boolean {
	const p = v as { slots?: Record<string, unknown>; allowedModels?: unknown; monthlyCapUsd?: unknown } | null;
	if (!p || typeof p !== "object" || !p.slots || typeof p.slots !== "object" || Array.isArray(p.slots)) return false;
	if (!Object.values(p.slots).every(isModel)) return false;
	if (!Array.isArray(p.allowedModels) || !p.allowedModels.every((k) => typeof k === "string")) return false;
	const c = p.monthlyCapUsd;
	return c === null || (typeof c === "number" && Number.isFinite(c) && c >= 0);
}

export const adminPolicyStore: AdminPolicyStore = {
	readPolicy() {
		let text: string;
		try {
			text = fs.readFileSync(file(), "utf-8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new AdminPolicyCorrupt();
		}
		let raw: Partial<AdminPolicy> | null;
		try {
			raw = JSON.parse(text) as Partial<AdminPolicy> | null;
		} catch {
			throw new AdminPolicyCorrupt();
		}
		if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.users || typeof raw.users !== "object" || Array.isArray(raw.users)) {
			throw new AdminPolicyCorrupt();
		}
		if (raw.newUserDefaults !== undefined && !isUserPolicy(raw.newUserDefaults)) throw new AdminPolicyCorrupt();
		if (!Object.values(raw.users).every(isUserPolicy)) throw new AdminPolicyCorrupt();
		return raw as AdminPolicy;
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
