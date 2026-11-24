/**
 * Session folders (owner design, 2026-11-24): the named seam the routes call.
 * Each mutation is one synchronous read → pure edit (core/session-folders.ts)
 * → write, then a "folders-changed" notice so other tabs refetch. Every
 * answer carries the derived view (assignments to a missing chat or folder
 * dropped). The store's SessionFoldersTooNew surfaces as 409.
 */

import { randomBytes } from "node:crypto";
import { emit } from "../core/events.ts";
import {
	addFolder,
	assignChat,
	removeFolder,
	renameFolder,
	sessionFoldersView,
	SessionFoldersTooNew,
	type FolderEdit,
	type FolderRefusal,
	type SessionFolder,
	type SessionFoldersRecord,
	type SessionFoldersView,
} from "../core/session-folders.ts";
import { stores } from "./stores.ts";

const STATUS: Record<FolderRefusal, number> = { invalid_name: 400, duplicate_name: 409, folder_not_found: 404, chat_not_found: 404 };

function liveView(record: SessionFoldersRecord): SessionFoldersView {
	return sessionFoldersView(record, new Set(stores.chatStore.listChats().map((c) => c.id)));
}

/** The derived view of the current tenant's folders. */
export function readSessionFolders(): SessionFoldersView {
	return liveView(stores.sessionFolderStore.readFolders());
}

export type FolderResult = { ok: true; view: SessionFoldersView; folder?: SessionFolder } | { ok: false; code: FolderRefusal };

function apply(edit: (record: SessionFoldersRecord) => FolderEdit): FolderResult {
	const result = edit(stores.sessionFolderStore.readFolders());
	if (!result.ok) return result;
	stores.sessionFolderStore.writeFolders(result.record);
	emit("folders-changed", {});
	return { ok: true, view: liveView(result.record), ...(result.folder ? { folder: result.folder } : {}) };
}

export const sessionFolders = {
	read: (): FolderResult => ({ ok: true, view: readSessionFolders() }),
	create: (name: unknown) => apply((r) => addFolder(r, name, `fld_${randomBytes(8).toString("hex")}`, new Date().toISOString())),
	rename: (id: string, name: unknown) => apply((r) => renameFolder(r, id, name)),
	remove: (id: string) => apply((r) => removeFolder(r, id)),
	assign: (chatId: string, folderId: string | null): FolderResult =>
		stores.chatStore.getChat(chatId) === null ? { ok: false, code: "chat_not_found" } : apply((r) => assignChat(r, chatId, folderId)),
};

/** Runs one folder operation and answers it: the view (plus the folder when
 *  one was made or renamed), a refusal with its status, or 409
 *  session_folders_too_new when the file is stamped newer than this build. */
export function folderResponse(run: () => FolderResult, okStatus = 200): Response {
	try {
		const out = run();
		if (!out.ok) return Response.json({ error: out.code }, { status: STATUS[out.code] });
		return Response.json({ ...out.view, ...(out.folder ? { folder: out.folder } : {}) }, { status: okStatus });
	} catch (err) {
		if (err instanceof SessionFoldersTooNew) return Response.json({ error: "session_folders_too_new" }, { status: 409 });
		throw err;
	}
}
