/**
 * Web Push device registration (mobile E). GET hands the browser the VAPID
 * public key to subscribe with; POST stores its PushSubscription; DELETE
 * forgets an endpoint. Transport only - src/server/push.ts owns the logic.
 */
import { z } from "zod";
import { pushPublicKey, subscribe, unsubscribe, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

const subscribeBody = z.object({
	subscription: z.object({
		endpoint: z.url(),
		keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
	}),
	label: z.string().max(100).optional(),
});
const unsubscribeBody = z.object({ endpoint: z.string().min(1) });

export const GET = withTenant(async () => {
	return Response.json({ publicKey: pushPublicKey() });
});

export const POST = withTenant(async (req: Request) => {
	const parsed = subscribeBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid subscription" }, { status: 400 });
	const { subscription, label } = parsed.data;
	subscribe(subscription, label?.trim() || (req.headers.get("user-agent") ?? "").slice(0, 100) || "Unknown device");
	return new Response(null, { status: 204 });
});

export const DELETE = withTenant(async (req: Request) => {
	const parsed = unsubscribeBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid endpoint" }, { status: 400 });
	unsubscribe(parsed.data.endpoint);
	return new Response(null, { status: 204 });
});
