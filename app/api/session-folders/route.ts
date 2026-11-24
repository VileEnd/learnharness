import { folderResponse, sessionFolders, withTenant } from "@/src/server";

/** The user's session folders: `{folders, assignments}` (assignments to a
 *  missing chat or folder are left out). */
export const GET = withTenant(async () => folderResponse(sessionFolders.read));

/** Create a folder: `{name}`, trimmed, 1–60 characters, unique ignoring case.
 *  201 with the view and `folder`; 400 invalid_name, 409 duplicate_name. */
export const POST = withTenant(async (req: Request) => {
	const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
	return folderResponse(() => sessionFolders.create(body?.name), 201);
});
