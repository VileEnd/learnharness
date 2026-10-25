"use client";

/**
 * The installed-app runtime (browser-only self-hosting, 2026-10-25):
 * registers the service worker (public/sw.js — offline screen, cached
 * static assets, push notifications) and offers the reload when a new
 * version has been deployed. Production only: in `next dev` a worker would
 * cache the dev server's chunks.
 */
import { useEffect, useState } from "react";

export function PwaRuntime() {
	const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

	useEffect(() => {
		if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
		let registration: ServiceWorkerRegistration | undefined;
		let reloading = false;

		const watch = (reg: ServiceWorkerRegistration) => {
			// A worker already waiting from an earlier visit.
			if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
			reg.addEventListener("updatefound", () => {
				const next = reg.installing;
				next?.addEventListener("statechange", () => {
					// "installed" with a controller = an UPDATE (not the first install).
					if (next.state === "installed" && navigator.serviceWorker.controller) setWaiting(next);
				});
			});
		};
		const onControllerChange = () => {
			if (reloading) return;
			reloading = true;
			location.reload();
		};
		// Coming back to the app is when a deploy is most likely to be noticed.
		const onVisible = () => {
			if (document.visibilityState === "visible") void registration?.update().catch(() => {});
		};

		navigator.serviceWorker
			.register("/sw.js", { scope: "/", updateViaCache: "none" })
			.then((reg) => {
				registration = reg;
				watch(reg);
			})
			.catch((err) => console.warn("[pwa] service worker registration failed:", err));
		navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);

	if (!waiting) return null;
	return (
		<div
			role="status"
			data-testid="pwa-update"
			className="fixed inset-x-0 bottom-0 z-[90] flex justify-center p-3 pb-safe pointer-events-none"
		>
			<div className="pointer-events-auto mb-2 flex items-center gap-3 rounded-xl border bg-card px-4 py-2 text-sm shadow-lg">
				<span className="text-foreground">A new version is available.</span>
				<button
					type="button"
					onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}
					className="min-h-9 rounded-lg bg-primary px-3 font-medium text-primary-foreground"
				>
					Reload
				</button>
				<button
					type="button"
					aria-label="Later"
					onClick={() => setWaiting(null)}
					className="min-h-9 px-1 text-muted-foreground"
				>
					Later
				</button>
			</div>
		</div>
	);
}
