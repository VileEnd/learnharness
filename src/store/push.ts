/**
 * The PushStore adapter: Web Push subscriptions (data/push/subscriptions.json)
 * and the server's VAPID key pair (data/push/vapid.json). Both are mode 0600:
 * endpoints are capability URLs and the private key signs every push. Implements
 * core/ports.ts PushStore; the server (src/server/push.ts) is the only writer.
 *
 * Reads never throw: absent or corrupt files are the first-boot state
 * (no subscriptions, no keys yet). Writes are atomic (tmp in the same dir +
 * rename, the auth store's idiom).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { PushStore, PushSubscriptionRecord, VapidKeys } from "../core/ports.ts";

const SUBS_FILE = path.join(PATHS.push, "subscriptions.json");
const VAPID_FILE = path.join(PATHS.push, "vapid.json");

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown, mode: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode });
	fs.chmodSync(tmp, mode); // umask may have relaxed the create mode
	fs.renameSync(tmp, file);
}

function isSub(v: unknown): v is PushSubscriptionRecord {
	const s = v as PushSubscriptionRecord | null;
	return (
		!!s &&
		typeof s.endpoint === "string" &&
		typeof s.keys?.p256dh === "string" &&
		typeof s.keys?.auth === "string"
	);
}

function listSubscriptions(): PushSubscriptionRecord[] {
	const raw = readJson(SUBS_FILE);
	return Array.isArray(raw) ? raw.filter(isSub) : [];
}

export const pushStore: PushStore = {
	listSubscriptions,
	saveSubscription(sub) {
		const rest = listSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
		writeJson(SUBS_FILE, [...rest, sub], 0o600);
	},
	removeSubscription(endpoint) {
		const all = listSubscriptions();
		const rest = all.filter((s) => s.endpoint !== endpoint);
		if (rest.length !== all.length) writeJson(SUBS_FILE, rest, 0o600);
	},
	readVapid() {
		const raw = readJson(VAPID_FILE) as Partial<VapidKeys> | null;
		return raw && typeof raw.publicKey === "string" && typeof raw.privateKey === "string"
			? { publicKey: raw.publicKey, privateKey: raw.privateKey }
			: null;
	},
	writeVapid(keys) {
		writeJson(VAPID_FILE, keys, 0o600);
	},
};
