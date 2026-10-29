/**
 * WireGuard device service (admin Users section). Creates a peer with a fresh
 * client keypair, persists only the PUBLIC half, and returns the client config
 * (with the private key) plus a QR once, in the create response. The private
 * key is never stored or logged.
 */

import crypto from "node:crypto";
import QRCode from "qrcode";
import { clientConfig, nextFreeIp, type WgPeer } from "../core/contracts/wireguard.ts";
import { stores } from "./stores.ts";

export class WireGuardNotReady extends Error {
	constructor() {
		super("wireguard_not_ready");
	}
}
export class WireGuardFull extends Error {
	constructor() {
		super("wireguard_full");
	}
}

const b64 = (b64url: string) => Buffer.from(b64url, "base64url").toString("base64");

/** A fresh X25519 pair as raw 32-byte keys, standard base64 (WireGuard format). */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
	return { privateKey: b64(privateKey.export({ format: "jwk" }).d!), publicKey: b64(publicKey.export({ format: "jwk" }).x!) };
}

export type DeviceView = Omit<WgPeer, "presharedKey"> & { latestHandshake: number | null; stale: boolean };

function view(p: WgPeer, allowedIps: string | undefined, handshakes: Record<string, { latestHandshake: number | null }>): DeviceView {
	const { presharedKey: _omit, ...rest } = p;
	return {
		...rest,
		latestHandshake: handshakes[p.publicKey]?.latestHandshake ?? null,
		// A peer without allowedIps predates the field and counts as stale by design.
		stale: !p.revokedAt && allowedIps !== undefined && p.allowedIps !== allowedIps,
	};
}

export function listDevices(userId?: string): DeviceView[] {
	const { wireGuardStore: wg } = stores;
	const allowedIps = wg.readServer()?.allowedIps;
	const handshakes = wg.readStatus()?.peers ?? {};
	return wg
		.readPeers()
		.filter((p) => !userId || p.userId === userId)
		.map((p) => view(p, allowedIps, handshakes));
}

export async function createDevice(userId: string, name: string): Promise<{ device: DeviceView; config: string; qrSvg: string }> {
	const { wireGuardStore: wg } = stores;
	const server = wg.readServer();
	if (!server) throw new WireGuardNotReady();
	const peers = wg.readPeers();
	const ip = nextFreeIp(peers);
	if (!ip) throw new WireGuardFull();
	const keys = generateKeyPair();
	const presharedKey = crypto.randomBytes(32).toString("base64");
	const peer: WgPeer = {
		id: crypto.randomUUID(),
		userId,
		name,
		publicKey: keys.publicKey,
		presharedKey,
		ip,
		createdAt: new Date().toISOString(),
		allowedIps: server.allowedIps,
	};
	wg.writePeers([...peers, peer]);
	const config = clientConfig({
		privateKey: keys.privateKey,
		address: ip,
		serverPublicKey: server.publicKey,
		presharedKey,
		endpoint: server.endpoint,
		allowedIps: server.allowedIps,
	});
	const qrSvg = await QRCode.toString(config, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
	return { device: view(peer, server.allowedIps, {}), config, qrSvg };
}

/** Marks the peer revoked (the entry and its address stay). False when unknown. */
export function revokeDevice(id: string): boolean {
	const { wireGuardStore: wg } = stores;
	const peers = wg.readPeers();
	const hit = peers.find((p) => p.id === id);
	if (!hit) return false;
	if (!hit.revokedAt) {
		hit.revokedAt = new Date().toISOString();
		wg.writePeers(peers);
	}
	return true;
}
