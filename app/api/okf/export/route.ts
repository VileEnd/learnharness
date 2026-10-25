/**
 * GET /api/okf/export - the learner's library as a zip: the full OKF v0.2
 * bundle (documents, sections, concepts, topics) plus viz.html, a graph viewer.
 * Rendered on demand; the agent gates do not apply (they govern the agents).
 */
import { library, zipFiles } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const zip = zipFiles(library.renderExport());
	return new Response(new Uint8Array(zip), {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": 'attachment; filename="learnharness-okf.zip"',
			"Content-Length": String(zip.length),
			"Cache-Control": "no-store",
		},
	});
}
