/**
 * PUT /api/keys/:id — save one key; DELETE — remove it (auth-keys wave,
 * 2026-09-19). `id` is the env-var/file key name (OPENROUTER_API_KEY, …).
 *
 * PUT body {value}: shape-gated (owner decision — bad pastes are 400s
 * naming the expected format, never stored; validation is SHAPE-ONLY, no
 * live pings). Saves take effect immediately (file + env reflected; no
 * restart). A var owned by the REAL env is persisted for later but NOT
 * reflected — the response's status row carries shadowedByEnv so the page
 * can explain why the saved key is not the live one.
 *
 * DELETE: gone from the file always; the env copy goes only when it was
 * the store's own reflection (a real env var stays — env wins). Idempotent
 * (absent key = success). Writable ids are the CURATED CATALOG ∪ THE
 * MODEL-PROVIDER env vars (provider-keys interlude); anything else is 404
 * — unknown file vars are preserved, not editable.
 *
 * A key file that exists but is not a valid JSON object is never written
 * over (that would erase every other key): PUT and DELETE answer 500 and
 * change nothing.
 */
import { AuthFileUnreadableError, isWritableAuthKey, requireAdmin, withTenant } from "@/src/server";
import { deleteKey, saveKey } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** The damaged-key-file refusal as a 500 with its own message; anything else rethrows. */
function unreadable(err: unknown): Response {
	if (err instanceof AuthFileUnreadableError) return Response.json({ error: err.message }, { status: 500 });
	throw err;
}

export const PUT = withTenant(async (req: Request, { params }: Params) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const { id } = await params;
	if (!isWritableAuthKey(id)) {
		return Response.json({ error: `unknown key "${id}"` }, { status: 404 });
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { value?: unknown }).value !== "string") {
		return Response.json({ error: "body must be {value: string}" }, { status: 400 });
	}
	let result: ReturnType<typeof saveKey>;
	try {
		result = saveKey(id, (body as { value: string }).value);
	} catch (err) {
		return unreadable(err);
	}
	if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
	return Response.json({ status: result.status });
});

export const DELETE = withTenant(async (_req: Request, { params }: Params) => {
	const denied = requireAdmin();
	if (denied) return denied;
	const { id } = await params;
	if (!isWritableAuthKey(id)) {
		return Response.json({ error: `unknown key "${id}"` }, { status: 404 });
	}
	try {
		return Response.json({ status: deleteKey(id) });
	} catch (err) {
		return unreadable(err);
	}
});
