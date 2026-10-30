/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). Ordinary reads never throw (absent/corrupt file = {} = "no
 * keys yet", the documented first-boot state, matching settings doctrine)
 * and unknown vars are preserved verbatim (forward-compat: future entries
 * ride along untouched until a catalog entry adopts them).
 *
 * The custom endpoint's key + binding pair (upstream port 6) is the one
 * strict exception: readCustomAuth/writeCustomAuth refuse a damaged file
 * instead of reading it as {} (a write would erase every key), and the
 * ordinary setters refuse the two reserved names, so only
 * src/server/custom-provider-http.ts can change the pair.
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CUSTOM_AUTH_BINDING, parseCustomAuthBinding } from "../core/custom-provider-auth.ts";

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  tmp-in-same-dir + rename keeps the swap atomic; chmod BEFORE the
 *  rename so the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, unknown>): void {
	const dir = path.dirname(AUTH_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.auth.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, AUTH_FILE);
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		assertOrdinaryVar(name);
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		assertOrdinaryVar(name);
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
	readCustomAuth() {
		const map = readCustomMap();
		return { binding: parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING]), key: map[CUSTOM_PROVIDER.envVar] as string | undefined };
	},
	writeCustomAuth(binding, key) {
		const map = readCustomMap();
		if (binding && !parseCustomAuthBinding(JSON.stringify(binding))) throw new Error("Invalid custom authorization record");
		setOwn(map, CUSTOM_PROVIDER.envVar, key);
		setOwn(map, CUSTOM_AUTH_BINDING, binding && JSON.stringify(binding));
		writeMap(map);
	},
};

function assertOrdinaryVar(name: string): void {
	if (name === CUSTOM_AUTH_BINDING || name === CUSTOM_PROVIDER.envVar) throw new Error("Use the custom endpoint editor");
}

function setOwn(map: Record<string, unknown>, name: string, value: string | undefined): void {
	if (value === undefined) delete map[name];
	else Object.defineProperty(map, name, { value, enumerable: true, configurable: true, writable: true });
}

/** The whole map (every JSON value kept) for the custom pair; throws on
 *  anything but absent or a well-formed object with a valid pair. */
function readCustomMap(): Record<string, unknown> {
	let text: string;
	try {
		text = fs.readFileSync(AUTH_FILE, "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error("Custom authorization storage unavailable");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("Custom authorization storage unavailable");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Custom authorization storage unavailable");
	const map = raw as Record<string, unknown>;
	if (Object.hasOwn(map, CUSTOM_AUTH_BINDING) && !parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING])) throw new Error("Invalid custom authorization record");
	if (Object.hasOwn(map, CUSTOM_PROVIDER.envVar) && typeof map[CUSTOM_PROVIDER.envVar] !== "string") throw new Error("Invalid custom credential record");
	return map;
}
