/**
 * The WireGuardStore adapter: <globalDataRoot()>/wireguard/. peers.json is
 * app-written (tmp + rename, mode 0600); server.json and status.json belong
 * to the host and are only read. Reads never throw. Implements
 * core/ports.ts WireGuardStore.
 */

import fs from "node:fs";
import path from "node:path";
import { globalDataRoot } from "../../config.ts";
import type { WireGuardStore } from "../core/ports.ts";
import { PeersFileCorrupt, type WgPeer, type WgServerInfo, type WgStatus } from "../core/contracts/wireguard.ts";

const dir = () => path.join(globalDataRoot(), "wireguard");

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

const str = (v: unknown): v is string => typeof v === "string";
const CONTROL = /[\u0000-\u001f\u007f]/;
const clean = (v: unknown): v is string => str(v) && !CONTROL.test(v);

function isPeer(v: unknown): v is WgPeer {
	const p = v as WgPeer | null;
	return !!p && str(p.id) && str(p.userId) && str(p.name) && str(p.publicKey) && str(p.presharedKey) && str(p.ip) && str(p.createdAt);
}

export const wireGuardStore: WireGuardStore = {
	readServer() {
		const s = readJson(path.join(dir(), "server.json")) as Partial<WgServerInfo> | null;
		return s && clean(s.publicKey) && clean(s.endpoint) && clean(s.allowedIps)
			? { publicKey: s.publicKey, endpoint: s.endpoint, allowedIps: s.allowedIps }
			: null;
	},
	readPeers() {
		const file = path.join(dir(), "peers.json");
		if (!fs.existsSync(file)) return [];
		// Present but unreadable/invalid: throw, so no writer can overwrite (and lose) peers or reuse their IPs.
		const raw = readJson(file) as { peers?: unknown } | null;
		if (!raw || !Array.isArray(raw.peers) || !raw.peers.every(isPeer)) throw new PeersFileCorrupt();
		return raw.peers;
	},
	writePeers(peers) {
		const file = path.join(dir(), "peers.json");
		fs.mkdirSync(dir(), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, peers }, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, file);
	},
	readStatus() {
		const s = readJson(path.join(dir(), "status.json")) as Partial<WgStatus> | null;
		return s && s.peers && typeof s.peers === "object" ? { updatedAt: str(s.updatedAt) ? s.updatedAt : "", peers: s.peers } : null;
	},
};
