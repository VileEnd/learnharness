/**
 * WireGuard device contracts (browser-safe: no node imports; key generation
 * lives in src/server/wireguard.ts). Peers are stored by the app in
 * `<globalDataRoot()>/wireguard/peers.json`; `server.json` and `status.json`
 * are written by the host and only read here.
 */

export const WG_SUBNET_PREFIX = "10.66.0.";
export const WG_FIRST_HOST = 2;
export const WG_LAST_HOST = 254;

/** One device's peer entry. Never holds the client's private key. */
export interface WgPeer {
	id: string;
	userId: string;
	name: string;
	publicKey: string;
	presharedKey: string;
	ip: string;
	createdAt: string;
	revokedAt?: string;
	/** server.allowedIps at creation time; drives the `stale` flag. Ignored by the host applier. */
	allowedIps?: string;
}

/** Written by the host. */
export interface WgServerInfo {
	publicKey: string;
	endpoint: string;
	allowedIps: string;
}

/** Written by the host. */
export interface WgStatus {
	updatedAt: string;
	peers: Record<string, { latestHandshake: number | null; endpoint: string | null }>;
}

/** Lowest unused 10.66.0.x (x in 2..254), counting revoked peers as used; null when full. */
export function nextFreeIp(peers: WgPeer[]): string | null {
	const used = new Set(peers.map((p) => p.ip));
	for (let n = WG_FIRST_HOST; n <= WG_LAST_HOST; n++) {
		const ip = `${WG_SUBNET_PREFIX}${n}`;
		if (!used.has(ip)) return ip;
	}
	return null;
}

export function clientConfig(p: {
	privateKey: string;
	address: string;
	serverPublicKey: string;
	presharedKey: string;
	endpoint: string;
	allowedIps: string;
}): string {
	return [
		"[Interface]",
		`PrivateKey = ${p.privateKey}`,
		`Address = ${p.address}/32`,
		"",
		"[Peer]",
		`PublicKey = ${p.serverPublicKey}`,
		`PresharedKey = ${p.presharedKey}`,
		`Endpoint = ${p.endpoint}`,
		`AllowedIPs = ${p.allowedIps}`,
		"PersistentKeepalive = 25",
		"",
	].join("\n");
}

/** peers.json exists but is unparseable or holds an invalid entry: writers must refuse rather than drop peers. */
export class PeersFileCorrupt extends Error {
	constructor() {
		super("wireguard_peers_corrupt");
	}
}
