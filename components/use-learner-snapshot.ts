"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
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
	const [bump, setBump] = useState(0);
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = useCallback(() => {
		if (debounce.current) clearTimeout(debounce.current);
		debounce.current = setTimeout(() => {
			debounce.current = undefined;
			setBump((b) => b + 1);
		}, 400);
	}, []);
	useServerEvent("turn-settled", schedule);
	useServerResync(schedule);
	useEffect(
		() => () => {
			if (debounce.current) clearTimeout(debounce.current);
		},
		[],
	);
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
