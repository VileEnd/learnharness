/**
 * This device's Web Push subscription, kept in line with the server's record.
 * The browser owns the subscription; the server stores a copy per signed-in
 * user (POST /api/push, DELETE /api/push - see src/server/push.ts). Both
 * helpers are best effort: a failed request never throws, because their
 * callers (the settings row on load, the sign-out link) must carry on.
 */

export async function currentSubscription(): Promise<PushSubscription | null> {
	const reg = await navigator.serviceWorker.ready;
	return reg.pushManager.getSubscription();
}

/** Tell the server about a browser subscription (idempotent: the endpoint is the identity). */
export function registerSubscription(sub: PushSubscription): Promise<Response> {
	return fetch("/api/push", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subscription: sub.toJSON() }),
	});
}

/** On load: when the browser holds a subscription, register it again so a
 *  server that lost it (another user signed in here, a wiped record) is brought
 *  in line. Resolves to whether the browser is subscribed. */
export async function syncPushSubscription(): Promise<boolean> {
	const sub = await currentSubscription();
	if (!sub) return false;
	await registerSubscription(sub).catch(() => {});
	return true;
}

/** On sign-out: forget this device on the server (while the session still
 *  works), then unsubscribe in the browser, so the next user of the browser
 *  does not inherit the previous user's notifications. */
export async function dropPushSubscription(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const sub = await currentSubscription();
	if (!sub) return;
	await fetch("/api/push", {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ endpoint: sub.endpoint }),
	}).catch(() => {});
	await sub.unsubscribe().catch(() => {});
}
