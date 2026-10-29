/**
 * POST /api/documents/[id]/describe - regenerate a document's title, summary
 * and topics from its stored content (no re-extraction). For documents whose
 * front matter only carried a filename-derived title.
 */
import { MODEL_NOT_ALLOWED_CODE, MONTHLY_CAP_REACHED_CODE, POLICY_UNAVAILABLE_CODE } from "@/src/core";
import { documents, withTenant } from "@/src/server";

const POLICY_CODES: readonly unknown[] = [MONTHLY_CAP_REACHED_CODE, MODEL_NOT_ALLOWED_CODE, POLICY_UNAVAILABLE_CODE];

export const dynamic = "force-dynamic";

export const POST = withTenant(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const result = await documents.redescribe(id);
	// A per-user policy refusal is a 403 (its own envelope), not a server fault.
	const status = result.ok ? 200 : result.error === "No such document" ? 404 : POLICY_CODES.includes(result.code) ? 403 : 500;
	return Response.json(result, { status });
});
