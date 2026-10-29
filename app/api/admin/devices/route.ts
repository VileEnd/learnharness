/**
 * Admin WireGuard devices.
 *   GET  ?userId= → {devices}
 *   POST {userId, name} → 201 {device, config, qrSvg} (the config holds the client private key, shown once, never stored)
 * Admin only; 503 wireguard_not_ready until the host has written server.json.
 */
import { TENANT_ID_RE, WireGuardFull, WireGuardNotReady, createDevice, listDevices, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

const NAME_RE = /^[A-Za-z0-9 ._-]{1,40}$/;

export const GET = withTenant(async (req: Request) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const userId = new URL(req.url).searchParams.get("userId") ?? undefined;
	if (userId !== undefined && !TENANT_ID_RE.test(userId)) return Response.json({ error: "invalid_user" }, { status: 400 });
	return Response.json({ devices: listDevices(userId) });
});

export const POST = withTenant(async (req: Request) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const body = (await req.json().catch(() => null)) as { userId?: unknown; name?: unknown } | null;
	if (typeof body?.userId !== "string" || !TENANT_ID_RE.test(body.userId)) return Response.json({ error: "invalid_user" }, { status: 400 });
	if (typeof body.name !== "string" || !NAME_RE.test(body.name)) return Response.json({ error: "invalid_name" }, { status: 400 });
	try {
		return Response.json(await createDevice(body.userId, body.name), { status: 201 });
	} catch (e) {
		if (e instanceof WireGuardNotReady) return Response.json({ error: "wireguard_not_ready" }, { status: 503 });
		if (e instanceof WireGuardFull) return Response.json({ error: "wireguard_full" }, { status: 409 });
		throw e;
	}
});
