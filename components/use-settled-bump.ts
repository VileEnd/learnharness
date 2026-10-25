"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";

/**
 * A counter that bumps (debounced) whenever the learner's truth may have
 * moved: a settled turn (quizzes and practice land evidence there) and a
 * channel reconnect. Notify, then fetch: effects keyed on it refetch.
 * Shared by the learner overlay's hook and the "My knowledge" view.
 */
export function useSettledBump(): number {
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
	return bump;
}
