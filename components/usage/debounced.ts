/**
 * A trailing debounce: N rapid calls to `trigger` run `fn` once, `ms` after
 * the last one. `cancel` drops a pending run. Pure; timers are the globals,
 * so tests drive it with node:test mock.timers.
 */
export function debounced(fn: () => void, ms: number): { trigger: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		trigger: () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				fn();
			}, ms);
		},
		cancel: () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
