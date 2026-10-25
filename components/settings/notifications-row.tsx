"use client";
/**
 * "Notifications on this device" (mobile E): the per-device Web Push opt-in.
 *
 * State lives in the browser, not in settings: whether THIS device is
 * subscribed is read from pushManager.getSubscription(). Enabling asks for
 * permission inside the click (iOS and most browsers require the user
 * gesture), subscribes with the server's VAPID key, and registers the result
 * (POST /api/push); disabling unsubscribes and tells the server (DELETE).
 * iOS only exposes PushManager to the installed Home Screen app (16.4+), so
 * a plain Safari tab gets an install hint instead of a dead switch.
 */

import { useEffect, useState } from "react";
import { SettingsRow, Toggle } from "./controls.tsx";

type Support = "checking" | "ok" | "ios-install" | "unsupported";

function detectSupport(): Support {
	if (typeof window === "undefined") return "checking";
	const hasPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
	if (hasPush) return "ok";
	const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
	return ios ? "ios-install" : "unsupported";
}

/** The VAPID key arrives base64url; pushManager.subscribe wants bytes. */
function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
	const base64 = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
	const reg = await navigator.serviceWorker.ready;
	return reg.pushManager.getSubscription();
}

export function NotificationsRow() {
	const [support, setSupport] = useState<Support>("checking");
	const [on, setOn] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const s = detectSupport();
		setSupport(s);
		if (s !== "ok") return;
		let alive = true;
		void currentSubscription().then((sub) => alive && setOn(sub !== null));
		return () => {
			alive = false;
		};
	}, []);

	async function enable() {
		// Permission first, straight from the click - nothing awaited before it.
		const permission = await Notification.requestPermission();
		if (permission !== "granted") {
			setError("Notifications are blocked for this site. Allow them in your browser or system settings.");
			return;
		}
		const keyRes = await fetch("/api/push");
		if (!keyRes.ok) throw new Error("could not fetch the push key");
		const { publicKey } = (await keyRes.json()) as { publicKey: string };
		const reg = await navigator.serviceWorker.ready;
		const sub =
			(await reg.pushManager.getSubscription()) ??
			(await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey),
			}));
		const res = await fetch("/api/push", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ subscription: sub.toJSON() }),
		});
		if (!res.ok) {
			await sub.unsubscribe();
			throw new Error("the server refused the subscription");
		}
		setOn(true);
	}

	async function disable() {
		const sub = await currentSubscription();
		if (sub) {
			await fetch("/api/push", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint: sub.endpoint }),
			});
			await sub.unsubscribe();
		}
		setOn(false);
	}

	async function toggle(next: boolean) {
		setBusy(true);
		setError(null);
		try {
			await (next ? enable() : disable());
		} catch (err) {
			setError(err instanceof Error ? `Could not change notifications: ${err.message}` : "Could not change notifications.");
		} finally {
			setBusy(false);
		}
	}

	const hint =
		error ??
		(support === "ios-install"
			? "Install the app to your Home Screen first (Share → Add to Home Screen)."
			: support === "unsupported"
				? "This browser does not support push notifications."
				: "Get a notification when your teacher replies or a background task finishes while the app is closed.");

	return (
		<SettingsRow label="Notifications on this device" hint={hint} testid="row-notifications">
			<Toggle
				checked={on}
				disabled={busy || support !== "ok"}
				label="notifications on this device"
				onChange={(next) => void toggle(next)}
			/>
		</SettingsRow>
	);
}
