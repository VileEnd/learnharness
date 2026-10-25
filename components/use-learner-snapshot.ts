"use client";

import { useEffect, useState } from "react";
import { useSettledBump } from "@/components/use-settled-bump";
import type { LearnerView } from "@/src/core";

/**
 * The learner model on the client: GET /api/learner, refetched whenever the
 * truth may have moved - the caller's `tick` (the graph view bumps it when
 * the graph refetches), a settled turn (quizzes and practice land evidence
 * there) and a channel reconnect. Notify, then fetch: the same law as the
 * graph's own refetch triggers. Disabled = no request, last value kept.
 * A failed fetch keeps the previous snapshot (the overlay is cosmetic).
 */
export function useLearnerSnapshot(enabled: boolean, tick = 0): LearnerView | null {
	const [snapshot, setSnapshot] = useState<LearnerView | null>(null);
	const bump = useSettledBump();
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		fetch("/api/learner")
			.then((res) => (res.ok ? (res.json() as Promise<LearnerView>) : null))
			.then((data) => {
				if (!cancelled && data) setSnapshot(data);
			})
			.catch((err) => console.error("[learner] fetch failed:", err));
		return () => {
			cancelled = true;
		};
	}, [enabled, tick, bump]);
	return snapshot;
}
