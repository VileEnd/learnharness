/**
 * The ModelCatalogStore adapter: <globalDataRoot()>/model-catalog.json, the
 * one instance-wide snapshot of the models refreshed from pi.dev (never
 * tenant data). Any read failure reads as null, and the server re-validates
 * every row it gets. Implements core/ports.ts ModelCatalogStore.
 */

import fs from "node:fs";
import path from "node:path";
import { globalDataRoot } from "../../config.ts";
import type { ModelCatalogStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** A snapshot larger than this is ignored on read (the writer refuses it too). */
export const MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;

const file = () => path.join(globalDataRoot(), "model-catalog.json");

export const modelCatalogStore: ModelCatalogStore = {
	readSnapshot() {
		try {
			const f = file();
			if (fs.statSync(f).size > MAX_MODEL_CATALOG_BYTES) return null;
			return JSON.parse(fs.readFileSync(f, "utf-8")) as unknown;
		} catch {
			return null;
		}
	},
	writeSnapshot(text) {
		const f = file();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		writeFileAtomicSync(f, text);
	},
};
