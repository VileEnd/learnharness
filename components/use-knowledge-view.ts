"use client";

import { useEffect, useState } from "react";
import { useSettledBump } from "@/components/use-settled-bump";
import type { KnowledgeView } from "@/src/core";

/** The "My knowledge" payload (GET /api/knowledge), refetched on the same triggers as the
 *  learner overlay (a settled turn, a channel reconnect). A failed refetch keeps the last value. */
export function useKnowledgeView(): { view: KnowledgeView | null; failed: boolean } {
	const [view, setView] = useState<KnowledgeView | null>(null);
	const [failed, setFailed] = useState(false);
	const bump = useSettledBump();
	useEffect(() => {
		let cancelled = false;
		fetch("/api/knowledge")
			.then((res) => (res.ok ? (res.json() as Promise<KnowledgeView>) : Promise.reject(new Error(String(res.status)))))
			.then((data) => {
				if (cancelled) return;
				setView(data);
				setFailed(false);
			})
			.catch((err) => {
				console.error("[knowledge] fetch failed:", err);
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [bump]);
	return { view, failed };
}
