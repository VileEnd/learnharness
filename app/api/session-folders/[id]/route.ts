import { FOLDER_ID_RE } from "@/src/core";
import { folderResponse, sessionFolders, withTenant } from "@/src/server";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => Response.json({ error: "folder_not_found" }, { status: 404 });

/** Rename: `{name}` under the create rules. */
export const PATCH = withTenant(async (req: Request, { params }: Ctx) => {
	const { id } = await params;
	if (!FOLDER_ID_RE.test(id)) return notFound();
	const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
	return folderResponse(() => sessionFolders.rename(id, body?.name));
});

/** Delete the folder only: its sessions return to the unfiled list. */
export const DELETE = withTenant(async (_req: Request, { params }: Ctx) => {
	const { id } = await params;
	if (!FOLDER_ID_RE.test(id)) return notFound();
	return folderResponse(() => sessionFolders.remove(id));
});
