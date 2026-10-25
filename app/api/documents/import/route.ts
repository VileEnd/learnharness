/**
 * POST /api/documents/import - add documents to the library. Multipart:
 * field "files" plus an optional JSON field "decisions", an array aligned
 * with the files whose entries are "skip" | "replace" | "new" | "attach" (the server
 * re-checks every file; a duplicate or similar file with no decision is
 * skipped, a new file imports regardless).
 *
 * Answers 202 as soon as every file is accepted, skipped or refused - the
 * slow work (scanning a PDF, extraction) runs server-side in the background,
 * not tied to this request; progress lives in the activity dock and a push
 * notification closes it. Per-file tickets: {index, name, outcome: started |
 * skipped | failed, docId?, title?, error?, code?}.
 */
import type { DocumentDecision } from "@/src/core";
import { documents, incomingFiles } from "@/src/server";

export const dynamic = "force-dynamic";

const DECISIONS = new Set<string>(["skip", "replace", "new", "attach"]);

export async function POST(request: Request) {
	const form = await request.formData();
	const files = await incomingFiles(form);
	if (files.length === 0) return Response.json({ results: [], error: "no files" }, { status: 400 });
	let decisions: (DocumentDecision | undefined)[] = [];
	const raw = form.get("decisions");
	if (typeof raw === "string" && raw !== "") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) throw new Error("not an array");
			decisions = parsed.map((d) => (typeof d === "string" && DECISIONS.has(d) ? (d as DocumentDecision) : undefined));
		} catch {
			return Response.json({ results: [], error: "decisions must be a JSON array of skip | replace | new | attach" }, { status: 400 });
		}
	}
	const tickets = await documents.importFiles(files, decisions);
	// `completion` is the in-process tail; it never goes on the wire.
	return Response.json({ results: tickets.map(({ completion: _tail, ...ticket }) => ticket) }, { status: 202 });
}
