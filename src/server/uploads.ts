import { MAX_FILE_BYTES, MAX_REQUEST_BYTES } from "../core/upload-limits.ts";

/**
 * The bounded multipart read behind the document routes. The body is counted
 * as it streams in and the read stops the moment it passes the cap, so an
 * oversized upload is never buffered whole. The dialog sends one file per
 * request, which makes the request cap a per-file cap (file + envelope).
 *
 * Failures come back as a ready JSON Response (`{results: [], error}`):
 * 413 naming the file when the body is too big, 400 when the body is missing
 * or the multipart is incomplete.
 */

const fail = (status: number, error: string) => Response.json({ results: [], error }, { status });

/** Best effort: the first filename in the multipart head, for the 413 message. */
function firstFilename(chunks: Uint8Array[]): string | undefined {
	const head = new Uint8Array(8192);
	let n = 0;
	for (const chunk of chunks) {
		if (n >= head.length) break;
		const part = chunk.subarray(0, head.length - n);
		head.set(part, n);
		n += part.length;
	}
	const match = /filename="([^"\r\n]*)"/.exec(new TextDecoder("utf-8").decode(head.subarray(0, n)));
	return match?.[1] || undefined;
}

const tooLarge = (name?: string) =>
	fail(413, `${name ? `${name} is` : "The upload is"} too large: the limit is ${MAX_FILE_BYTES / 2 ** 20} MiB per file.`);

export async function readUploadForm(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<FormData | Response> {
	const body = request.body;
	if (!body) return fail(400, "Missing upload body.");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		if (Number(request.headers.get("content-length")) > maxBytes) return tooLarge();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) return tooLarge(firstFilename(chunks));
			chunks.push(value);
		}
	} catch {
		return fail(400, "Could not read the upload. It may be incomplete; please add the file again.");
	} finally {
		// Stop pulling at once; nothing waits for the rest of an oversized body.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const whole = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		whole.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return await new Response(whole, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} catch {
		return fail(400, "Could not read the upload. It may be incomplete; please add the file again.");
	}
}
