/**
 * POST /api/documents/estimate - the PDF scan cost estimate: a proxy to the
 * OCR sidecar's /api/estimate (the browser never talks to the sidecar or
 * sees its token). Multipart field "files"; only PDFs are forwarded.
 * 200 {files:[{name,pages,usd}], usd, default_strategy}; 400 with no PDF;
 * 503 {error, code} when the sidecar is not configured or unreachable.
 */
import { documents, incomingFiles, OcrError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const files = await incomingFiles(await request.formData());
	try {
		const estimate = await documents.estimate(files);
		if (!estimate) return Response.json({ error: "no PDF files" }, { status: 400 });
		return Response.json(estimate);
	} catch (err) {
		if (err instanceof OcrError) return Response.json({ error: err.message, code: err.code }, { status: 503 });
		throw err;
	}
}
