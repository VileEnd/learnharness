import { FOLDER_ID_RE } from "@/src/core";
import { folderResponse, sessionFolders, withTenant } from "@/src/server";

/** Move a session: `{folderId}` files it in that folder, `{folderId: null}`
 *  takes it out. The chat record is not touched. 400 on a malformed body,
 *  404 chat_not_found / folder_not_found. */
export const PUT = withTenant(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { folderId?: unknown } | null;
	const folderId = body?.folderId;
	if (folderId !== null && (typeof folderId !== "string" || !FOLDER_ID_RE.test(folderId))) {
		return Response.json({ error: "folderId must be a folder id or null" }, { status: 400 });
	}
	return folderResponse(() => sessionFolders.assign(id, folderId));
});
