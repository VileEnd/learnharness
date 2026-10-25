"use client";

/**
 * THE SIGNED-OUT SCREEN (browser-only self-hosting, 2026-10-25). The app has
 * no login of its own: Caddy + oauth2-proxy (Keycloak) sit in front, and
 * `/api/*` answers 401 once the login session has ended (deploy/caddy —
 * page loads still redirect to the login). Without this, an installed app
 * that outlived its session just showed "Failed to fetch" everywhere.
 *
 * One window-level watch, no call-site changes: `fetch` is wrapped once —
 * a 401 from our own `/api/*` means signed out; a NETWORK failure on our
 * own API is ambiguous (offline vs. a proxy redirect the browser refused),
 * so it asks oauth2-proxy directly (`/oauth2/auth`: 202 signed in, 401
 * signed out; unreachable = offline, not signed out). The events channel
 * reports its errors as `lh:events-error` for the same probe.
 *
 * Signing in again is a SAME-WINDOW navigation (never a popup / new tab:
 * an installed iOS app has its own cookie jar). Unsent text in the page's
 * text fields rides sessionStorage across the round-trip.
 */
import { useEffect, useState } from "react";

/** True for requests to this origin's `/api/*` (the guarded surface). */
export function isOwnApiRequest(input: RequestInfo | URL, origin: string): boolean {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw, origin);
		return url.origin === origin && url.pathname.startsWith("/api/");
	} catch {
		return false;
	}
}

const DRAFTS_KEY = "lh:signin-drafts";

function saveDrafts(): void {
	const drafts = [...document.querySelectorAll("textarea")].map((t) => t.value);
	if (!drafts.some((d) => d.trim())) return;
	try {
		sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ path: location.pathname, drafts }));
	} catch {
		/* storage unavailable: the drafts are lost, the sign-in still works */
	}
}

/** Put saved drafts back into the same page's text fields (React-safe: the
 *  native value setter + an input event, as if typed). */
function restoreDrafts(): void {
	let saved: { path?: string; drafts?: string[] } | null = null;
	try {
		saved = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "null");
		sessionStorage.removeItem(DRAFTS_KEY);
	} catch {
		return;
	}
	if (!saved || saved.path !== location.pathname || !Array.isArray(saved.drafts)) return;
	const drafts = saved.drafts;
	// The page's fields mount after hydration — give them a moment.
	setTimeout(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		document.querySelectorAll("textarea").forEach((t, i) => {
			const text = drafts[i];
			if (!text || t.value || !setter) return;
			setter.call(t, text);
			t.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}, 800);
}

export function signInAgain(): void {
	saveDrafts();
	location.assign(`/oauth2/sign_in?rd=${encodeURIComponent(location.href)}`);
}

export function SessionWatch() {
	const [signedOut, setSignedOut] = useState(false);

	useEffect(() => {
		restoreDrafts();
		const original = window.fetch.bind(window);
		let probing = false;
		const markSignedOut = () => setSignedOut(true);
		const probe = async () => {
			if (probing) return;
			probing = true;
			try {
				const res = await original("/oauth2/auth", { cache: "no-store", credentials: "same-origin" });
				if (res.status === 401) markSignedOut();
			} catch {
				/* unreachable: offline, not signed out */
			} finally {
				probing = false;
			}
		};
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const own = isOwnApiRequest(input, location.origin);
			try {
				const res = await original(input, init);
				if (own && res.status === 401) markSignedOut();
				return res;
			} catch (err) {
				if (own && err instanceof TypeError) void probe();
				throw err;
			}
		};
		const onEventsError = () => void probe();
		window.addEventListener("lh:events-error", onEventsError);
		return () => {
			window.fetch = original;
			window.removeEventListener("lh:events-error", onEventsError);
		};
	}, []);

	if (!signedOut) return null;
	return (
		<div
			role="alertdialog"
			aria-labelledby="lh-signed-out-title"
			data-testid="session-expired"
			className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-6 pt-safe pb-safe backdrop-blur"
		>
			<div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border bg-card p-6 text-center shadow-xl">
				<h2 id="lh-signed-out-title" className="text-base font-medium text-foreground">
					You're signed out
				</h2>
				<p className="text-sm text-muted-foreground">
					Your login session has ended. Sign in again to continue — text you haven't sent yet comes back with you.
				</p>
				<button
					type="button"
					onClick={signInAgain}
					className="min-h-11 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
				>
					Sign in again
				</button>
			</div>
		</div>
	);
}
