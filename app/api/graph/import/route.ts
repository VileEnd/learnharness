/**
 * POST /api/graph/import - the blocking, markdown-only alias of the
 * document library's import (POST /api/documents/import), kept so
 * scripts/import-notes.ts and older clients keep their contract: multipart
 * field "files", one result per file, answered once every file's extraction
 * has finished.
 *
 * Content decides, not the filename: a file whose text is already in the
 * library (exact duplicate or very similar) is skipped, not re-extracted -
 * its result is {ok: true, outcome: "completed", skipped: true, of: <title>}
 * with zero stats. (This reverses the old "always re-extract" behavior; the
 * Add-documents dialog is where a learner chooses Replace or Import as new.)
 * PDFs are refused here; they go through Add documents.
 */
import type { EmissionStats } from "@/src/core";
import { documents, incomingFiles, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal - the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: string;
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
	/** The library document this file is (or matched, when skipped). */
	docId?: string;
	/** True when the file was already in the library and nothing ran. */
	skipped?: boolean;
	/** Title of the stored document a skipped file matched. */
	of?: string;
}

export const POST = withTenant(async (request: Request) => {
	const files = await incomingFiles(await request.formData());
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}
	const tickets = await documents.importFiles(files, [], { markdownOnly: true });
	const results: ImportResult[] = await Promise.all(
		tickets.map(async (t): Promise<ImportResult> => {
			const base = { requestIndex: t.index, filePath: t.name };
			if (t.outcome === "skipped") {
				return { ...base, outcome: "completed", ok: true, stats: { nodes: 0, chains: 0 }, skipped: true, docId: t.docId, of: t.title };
			}
			if (t.outcome === "failed") {
				return { ...base, outcome: "failed", ok: false, error: t.error ?? "Import failed", code: t.code, missing: t.missing, provider: t.provider, slots: t.slots };
			}
			const done = await t.completion!;
			if (done.ok) return { ...base, outcome: "completed", ok: true, stats: done.stats ?? { nodes: 0, chains: 0 }, docId: t.docId };
			return {
				...base,
				outcome: done.outcome && done.outcome !== "completed" && done.outcome !== "skipped" ? done.outcome : "failed",
				ok: false,
				...(done.stats ? { stats: done.stats } : {}),
				error: done.error ?? "Import failed",
				code: done.code,
				missing: done.missing,
				provider: done.provider,
				slots: done.slots,
			};
		}),
	);
	return Response.json({ results });
});
