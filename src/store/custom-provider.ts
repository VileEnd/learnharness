/**
 * The CustomProviderStore adapter: <globalDataRoot()>/custom-provider.json,
 * the one instance-wide custom endpoint (never tenant settings). Written
 * tmp + rename at mode 0600. Absent reads as null; present but invalid
 * throws CustomProviderCorrupt. Implements core/ports.ts CustomProviderStore.
 */

import fs from "node:fs";
import path from "node:path";
import { globalDataRoot } from "../../config.ts";
import type { CustomProviderStore } from "../core/ports.ts";
import { CustomProviderCorrupt, isCustomProviderConfig } from "../core/contracts/custom-provider.ts";

const file = () => path.join(globalDataRoot(), "custom-provider.json");

export const customProviderStore: CustomProviderStore = {
	readConfig() {
		let text: string;
		try {
			text = fs.readFileSync(file(), "utf-8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new CustomProviderCorrupt();
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new CustomProviderCorrupt();
		}
		if (!isCustomProviderConfig(raw)) throw new CustomProviderCorrupt();
		return raw;
	},
	writeConfig(config) {
		const f = file();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		const tmp = `${f}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, f);
	},
	deleteConfig() {
		fs.rmSync(file(), { force: true });
	},
};
