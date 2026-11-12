/**
 * Web Push: the server half of "tell me when the teacher answered".
 *
 * The single writer of the PushStore. The VAPID key pair is generated on
 * first use (no infrastructure to provision) and lives in data/push/vapid.json.
 * notify() is a fire-and-forget side channel with the same containment law as
 * extraction/usage/naming: it never throws into its caller and a failed send
 * costs one log line. Dead subscriptions (HTTP 404/410 from the push service)
 * are pruned on the spot.
 *
 * VAPID subject: the project URL. Push services use it only as a contact
 * handle if they need to reach the sender; it must be an https: or mailto: URI
 * (Apple rejects anything else), and a repo URL avoids baking an email in.
 *
 * Endpoints come from the browser, so they pass the outbound guard
 * (agent/outbound.ts): https only, public hosts only. subscribe() resolves
 * and checks the host before storing; at send time a stored endpoint is
 * re-checked by name and the default sender connects through pushAgent(),
 * which checks every resolved address and connects to the one it checked.
 *
 * Tests inject the `send` seam; the default sender is silent under
 * NODE_ENV=test so no suite can ever reach a push service.
 */

import type * as https from "node:https";
import webpush from "web-push";
import { guardedHttpsAgent, hostRefusal, resolvePublicTarget } from "../agent/outbound.ts";
import type { PushSubscriptionRecord, VapidKeys } from "../core/ports.ts";
import { stores } from "./stores.ts";

const VAPID_SUBJECT = "https://github.com/VileEnd/learnharness";
const TTL_SECONDS = 60 * 60;

export type PushEvent =
	| { kind: "turn"; chatId: string; title: string }
	| { kind: "job"; chatId: string; jobKind: string; status: "done" | "error"; title: string }
	| { kind: "extraction"; label: string; status: "done" | "error" };

export interface PushPayload {
	title: string;
	body: string;
	/** Where the notification click lands. */
	url: string;
	/** Collapses notifications: one per chat, one for extraction. */
	tag: string;
}

/** The delivery seam: resolve on success, reject with `statusCode` set on an
 *  HTTP failure (web-push's WebPushError shape). */
export type PushSender = (sub: PushSubscriptionRecord, payload: string) => Promise<unknown>;

function vapidKeys(): VapidKeys {
	const existing = stores.pushStore.readVapid();
	if (existing) return existing;
	const keys = webpush.generateVAPIDKeys();
	stores.pushStore.writeVapid(keys);
	return keys;
}

/** The application server key the browser subscribes with. */
export function pushPublicKey(): string {
	return vapidKeys().publicKey;
}

/** A push endpoint the guard refused (or whose host did not resolve). */
export class PushEndpointError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PushEndpointError";
	}
}

/** Why a stored endpoint may not be sent to, without a lookup: not https,
 *  or a local name / non-public literal. Null when it may be tried. */
function endpointRefusal(endpoint: string): string | null {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return "invalid URL";
	}
	if (url.protocol !== "https:") return "not https";
	return hostRefusal(url.hostname);
}

/** Register (or refresh) a device. The endpoint is the identity. Throws
 *  PushEndpointError when the endpoint is not https or its host is not
 *  public (every resolved address is checked). */
export async function subscribe(
	sub: { endpoint: string; keys: { p256dh: string; auth: string } },
	label: string,
): Promise<void> {
	const refusal = endpointRefusal(sub.endpoint);
	if (refusal) throw new PushEndpointError(`Push endpoint refused: ${refusal}`);
	try {
		await resolvePublicTarget(new URL(sub.endpoint));
	} catch (err) {
		throw new PushEndpointError(`Push endpoint refused: ${err instanceof Error ? err.message : String(err)}`);
	}
	stores.pushStore.saveSubscription({
		endpoint: sub.endpoint,
		keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
		createdAt: new Date().toISOString(),
		label,
	});
}

export function unsubscribe(endpoint: string): void {
	stores.pushStore.removeSubscription(endpoint);
}

let agent: https.Agent | undefined;

/** The https.Agent every push send connects through: it resolves the
 *  endpoint host, refuses any non-public answer (or literal), and connects
 *  to the address it checked. */
export function pushAgent(): https.Agent {
	agent ??= guardedHttpsAgent();
	return agent;
}

const defaultSend: PushSender = (sub, payload) => {
	const { publicKey, privateKey } = vapidKeys();
	return webpush.sendNotification(sub, payload, {
		TTL: TTL_SECONDS,
		vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
		agent: pushAgent(),
	});
};

export function payloadFor(event: PushEvent): PushPayload {
	switch (event.kind) {
		case "turn":
			return {
				title: event.title || "LearnHarness",
				body: "Your teacher replied",
				url: `/chat/${event.chatId}`,
				tag: `chat:${event.chatId}`,
			};
		case "job":
			return {
				title: event.title || "LearnHarness",
				body: event.status === "done" ? `${event.jobKind} finished` : `${event.jobKind} failed`,
				url: `/chat/${event.chatId}`,
				tag: `chat:${event.chatId}`,
			};
		case "extraction":
			return {
				title: "LearnHarness",
				body: event.status === "done" ? `${event.label}: added to your graph` : `${event.label}: could not finish`,
				url: "/",
				tag: "extraction",
			};
	}
}

/** Push one event to every subscribed device. Never throws, never blocks the
 *  caller's work (callers `void` it). */
export async function notify(event: PushEvent, send?: PushSender): Promise<void> {
	if (!send && process.env.NODE_ENV === "test") return;
	try {
		const subs = stores.pushStore.listSubscriptions();
		if (subs.length === 0) return;
		const body = JSON.stringify(payloadFor(event));
		const deliver = send ?? defaultSend;
		await Promise.all(
			subs.map(async (sub) => {
				// Stored before the guard existed, or planted: never sent to.
				if (endpointRefusal(sub.endpoint)) {
					stores.pushStore.removeSubscription(sub.endpoint);
					return;
				}
				try {
					await deliver(sub, body);
				} catch (err) {
					const status = (err as { statusCode?: number }).statusCode;
					if (status === 404 || status === 410) stores.pushStore.removeSubscription(sub.endpoint);
					else console.error(`[push] send failed (${status ?? "network"}):`, err instanceof Error ? err.message : err);
				}
			}),
		);
	} catch (err) {
		console.error("[push] notify failed:", err instanceof Error ? err.message : err);
	}
}
