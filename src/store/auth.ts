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
 * ride along untouched until a catalog entry adopts them). Writes read
 * strictly: a file that exists but is not a JSON object throws
 * AuthFileUnreadableError, because writing the lenient {} back would
 * erase every other key.
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
import { writeFileAtomicSync } from "./atomic-write.ts";

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

/** The key file exists but cannot be read as a JSON object: a write over it
 *  would erase every key in it, so writes refuse (the key routes answer 500). */
export class AuthFileUnreadableError extends Error {
	constructor() {
		super("The key file (auth.json) could not be read as a JSON object, so nothing was changed. Fix or remove it, then try again.");
		this.name = "AuthFileUnreadableError";
	}
}

/** The whole map for a write (every JSON value kept): {} only when the file
 *  is absent; throws AuthFileUnreadableError when it exists but cannot be
 *  read or is not a JSON object. */
function readMapForWrite(): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new AuthFileUnreadableError();
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AuthFileUnreadableError();
	return raw as Record<string, unknown>;
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  writeFileAtomicSync: unique temp in the same dir, fchmod before any
 *  data, fsync, rename, so the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, unknown>): void {
	const dir = path.dirname(AUTH_FILE);
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(AUTH_FILE, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		assertOrdinaryVar(name);
		const map = readMapForWrite();
		setOwn(map, name, value);
		writeMap(map);
	},
	deleteAuthVar(name) {
		assertOrdinaryVar(name);
		const map = readMapForWrite();
		if (!Object.hasOwn(map, name)) return; // absent = silent success, idempotent
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
