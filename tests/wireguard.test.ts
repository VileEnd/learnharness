import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-wireguard-"));
process.env.LH_DATA_DIR = dataDir;
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;

const wgc = await import("../src/core/contracts/wireguard.ts");
const wg = await import("../src/server/wireguard.ts");
const devices = await import("../app/api/admin/devices/route.ts");
const device = await import("../app/api/admin/devices/[id]/route.ts");

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const wgDir = path.join(dataDir, "global", "wireguard");
const SERVER = { publicKey: Buffer.alloc(32, 7).toString("base64"), endpoint: "vpn.example.com:51820", allowedIps: "192.0.2.10/32" };

const req = (admin: boolean, init: RequestInit = {}, qs = "") =>
	new Request(`http://x/api/admin/devices${qs}`, {
		...init,
		headers: {
			"x-auth-request-user": ADMIN,
			"x-auth-request-groups": admin ? "/learnharness,/learnharness-admin" : "/learnharness",
			"content-type": "application/json",
		},
	});
const post = (admin: boolean, body: unknown) => devices.POST(req(admin, { method: "POST", body: JSON.stringify(body) }));

const peer = (n: number, extra: Partial<import("../src/core/contracts/wireguard.ts").WgPeer> = {}) => ({
	id: `p${n}`, userId: USER, name: "n", publicKey: `k${n}`, presharedKey: "x", ip: `10.66.0.${n}`, createdAt: "t", ...extra,
});

test("keypair: public key re-derives from the private key", () => {
	const { privateKey, publicKey } = wg.generateKeyPair();
	for (const k of [privateKey, publicKey]) assert.ok(k.length === 44 && k.endsWith("="));
	assert.equal(Buffer.from(privateKey, "base64").length, 32);
	assert.equal(Buffer.from(publicKey, "base64").length, 32);
	const b64u = (b: string) => Buffer.from(b, "base64").toString("base64url");
	const priv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: b64u(privateKey), x: b64u(publicKey) }, format: "jwk" });
	const derived = crypto.createPublicKey(priv).export({ format: "jwk" }).x!;
	assert.equal(Buffer.from(derived, "base64url").toString("base64"), publicKey);
});

test("nextFreeIp: lowest free, skips revoked, null when full", () => {
	assert.equal(wgc.nextFreeIp([]), "10.66.0.2");
	assert.equal(wgc.nextFreeIp([peer(2), peer(3, { revokedAt: "r" }), peer(5)]), "10.66.0.4");
	const all = Array.from({ length: 253 }, (_, i) => peer(i + 2));
	assert.equal(wgc.nextFreeIp(all), null);
});

test("clientConfig: exact lines, no name", () => {
	const cfg = wgc.clientConfig({ privateKey: "PRIV", address: "10.66.0.9", serverPublicKey: "SPUB", presharedKey: "PSK", endpoint: "vpn.example.com:51820", allowedIps: "192.0.2.10/32" });
	assert.equal(
		cfg,
		"[Interface]\nPrivateKey = PRIV\nAddress = 10.66.0.9/32\n\n[Peer]\nPublicKey = SPUB\nPresharedKey = PSK\nEndpoint = vpn.example.com:51820\nAllowedIPs = 192.0.2.10/32\nPersistentKeepalive = 25\n",
	);
	assert.ok(!/name/i.test(cfg));
});

test("POST without server.json: 503 wireguard_not_ready", async () => {
	const res = await post(true, { userId: USER, name: "phone" });
	assert.equal(res.status, 503);
	assert.deepEqual(await res.json(), { error: "wireguard_not_ready" });
});

test("non-admin gets 403 on every device route", async () => {
	assert.equal((await devices.GET(req(false))).status, 403);
	assert.equal((await post(false, { userId: USER, name: "x" })).status, 403);
	const res = await device.DELETE(req(false, { method: "DELETE" }), { params: Promise.resolve({ id: "p" }) });
	assert.equal(res.status, 403);
	assert.deepEqual(await res.json(), { error: "admin_only" });
});

test("create: sequential IPs, QR svg, config returned, nothing secret on disk", async () => {
	fs.mkdirSync(wgDir, { recursive: true });
	fs.writeFileSync(path.join(wgDir, "server.json"), JSON.stringify(SERVER));
	const r1 = await post(true, { userId: USER, name: "phone" });
	assert.equal(r1.status, 201);
	const b1 = (await r1.json()) as { device: Record<string, unknown>; config: string; qrSvg: string };
	const r2 = await post(true, { userId: USER, name: "laptop" });
	const b2 = (await r2.json()) as { device: { ip: string } };
	assert.equal(b1.device.ip, "10.66.0.2");
	assert.equal(b2.device.ip, "10.66.0.3");
	assert.ok(b1.qrSvg.startsWith("<svg"));
	assert.equal("presharedKey" in b1.device, false);
	const priv = /PrivateKey = (\S+)/.exec(b1.config)![1]!;
	const raw = fs.readFileSync(path.join(wgDir, "peers.json"), "utf8");
	assert.ok(!raw.includes(priv));
	assert.equal(fs.statSync(path.join(wgDir, "peers.json")).mode & 0o777, 0o600);
	const stored = JSON.parse(raw) as { version: number; peers: { allowedIps?: string; publicKey: string }[] };
	assert.equal(stored.version, 1);
	assert.equal(stored.peers[0]!.allowedIps, SERVER.allowedIps);
	assert.ok(b1.config.includes(`PublicKey = ${SERVER.publicKey}`));
});

test("validation: bad name and bad userId are 400", async () => {
	let res = await post(true, { userId: USER, name: "bad/name" });
	assert.deepEqual(await res.json(), { error: "invalid_name" });
	res = await post(true, { userId: USER, name: "" });
	assert.equal(res.status, 400);
	res = await post(true, { userId: "../x", name: "ok" });
	assert.equal(res.status, 400);
});

test("revoke keeps the entry; list joins handshake and flags stale; psk stripped", async () => {
	const peers = JSON.parse(fs.readFileSync(path.join(wgDir, "peers.json"), "utf8")) as { peers: { id: string; publicKey: string }[] };
	const first = peers.peers[0]!;
	fs.writeFileSync(path.join(wgDir, "status.json"), JSON.stringify({ updatedAt: "t", peers: { [first.publicKey]: { latestHandshake: 1234, endpoint: null } } }));
	let res = await device.DELETE(req(true, { method: "DELETE" }), { params: Promise.resolve({ id: first.id }) });
	assert.equal(res.status, 204);
	res = await device.DELETE(req(true, { method: "DELETE" }), { params: Promise.resolve({ id: "nope" }) });
	assert.equal(res.status, 404);
	const list = (await (await devices.GET(req(true, {}, `?userId=${USER}`))).json()) as { devices: Array<Record<string, unknown>> };
	assert.equal(list.devices.length, 2);
	const d0 = list.devices.find((d) => d.id === first.id)!;
	assert.ok(typeof d0.revokedAt === "string");
	assert.equal(d0.latestHandshake, 1234);
	assert.equal(d0.stale, false);
	assert.ok(list.devices.every((d) => !("presharedKey" in d)));
	// Host changes allowedIps: live peer becomes stale, revoked one does not.
	fs.writeFileSync(path.join(wgDir, "server.json"), JSON.stringify({ ...SERVER, allowedIps: "192.0.2.20/32" }));
	const after = wg.listDevices(USER);
	assert.deepEqual(after.map((d) => d.stale), [false, true]);
	assert.equal(wg.listDevices("other").length, 0);
});

test("control characters in server.json mean not ready", async () => {
	const file = path.join(wgDir, "server.json");
	const good = fs.readFileSync(file, "utf8");
	try {
		fs.writeFileSync(file, JSON.stringify({ ...SERVER, endpoint: "vpn.example.com:51820\nPostUp = x" }));
		const res = await post(true, { userId: USER, name: "evil" });
		assert.equal(res.status, 503);
		assert.deepEqual(await res.json(), { error: "wireguard_not_ready" });
	} finally {
		fs.writeFileSync(file, good);
	}
});

test("corrupt peers.json: create and revoke refuse (500) and leave the file untouched", async () => {
	const file = path.join(wgDir, "peers.json");
	const good = fs.readFileSync(file, "utf8");
	const valid = (JSON.parse(good) as { peers: unknown[] }).peers[0];
	try {
		for (const bad of ["{ not json", JSON.stringify({ version: 1, peers: [valid, { id: "x" }] })]) {
			fs.writeFileSync(file, bad);
			let res = await post(true, { userId: USER, name: "again" });
			assert.equal(res.status, 500);
			assert.deepEqual(await res.json(), { error: "wireguard_peers_corrupt" });
			res = await device.DELETE(req(true, { method: "DELETE" }), { params: Promise.resolve({ id: "x" }) });
			assert.equal(res.status, 500);
			res = await devices.GET(req(true));
			assert.equal(res.status, 500);
			assert.equal(fs.readFileSync(file, "utf8"), bad);
		}
	} finally {
		fs.writeFileSync(file, good);
	}
});
