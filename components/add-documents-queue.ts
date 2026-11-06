import { MAX_FILE_BYTES } from "@/src/core";

/**
 * Transport helpers for the Add-documents dialog: every request carries ONE
 * file, so no selection (many files, a whole folder) can reach a per-request
 * cap, and a failure belongs to exactly one row.
 */

/** A FIFO limiter: `run(task)` starts the task when fewer than `limit` are
 *  in flight. One instance per dialog, so later picks join the same queue. */
export function createTaskQueue(limit: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	const next = () => {
		if (active >= limit) return;
		waiting.shift()?.();
	};
	return function run<T>(task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			waiting.push(() => {
				active++;
				task().then(resolve, reject).finally(() => {
					active--;
					next();
				});
			});
			next();
		});
	};
}

/** The multipart body for one file. The name is always the file's own name:
 *  a folder pick's relative path (`webkitRelativePath`) never goes on the wire. */
export function fileForm(file: File, extra?: Record<string, string>): FormData {
	const form = new FormData();
	form.append("files", file, file.name);
	for (const [key, value] of Object.entries(extra ?? {})) form.append(key, value);
	return form;
}

/** Why a file cannot be sent at all (null = fine); checked before any request. */
export function tooLargeReason(file: File): string | null {
	return file.size > MAX_FILE_BYTES ? `Too large: the limit is ${MAX_FILE_BYTES / 2 ** 20} MiB per file.` : null;
}

/** A response's JSON body, or {} when it is not JSON (a proxy's plain 413). */
export async function jsonOf<T>(res: Response): Promise<Partial<T> & { error?: string }> {
	try {
		return (await res.json()) as Partial<T> & { error?: string };
	} catch {
		return { error: res.status === 413 ? "Too large for the server." : `HTTP ${res.status}` } as Partial<T> & { error?: string };
	}
}
