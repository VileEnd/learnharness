/**
 * Session folders (owner design, 2026-11-24): one level of user folders in
 * the sidebar. Pure and browser-safe: the record shape, the name rule, and
 * the one derivation every reader shares (server view, sidebar grouping).
 *
 * Storage is a small per-user file (`session-folders.json` in the tenant's
 * data dir, SessionFolderStore); chat records are never rewritten for it.
 * Assignments map chatId → folderId and are DERIVED on read: an assignment
 * to a missing chat or a missing folder is ignored, never repaired by a read.
 * Deleting a session leaves its assignment in the file to be ignored this
 * way; deleting a folder drops its assignments with it (its sessions return
 * to the unfiled list, none is deleted).
 */

import type { ChatListItem } from "./contracts.ts";
import { fuzzyScore } from "./fuzzy.ts";

/** The record's schema counter. A file stamped higher is refused (read and write). */
export const CURRENT_SESSION_FOLDERS_VERSION = 1;
/** Folder names: trimmed, 1–60 characters. */
export const FOLDER_NAME_MAX = 60;
/** Folder ids the store mints: `fld_` + 16 hex characters. */
export const FOLDER_ID_RE = /^fld_[0-9a-f]{16}$/;

export interface SessionFolder {
	id: string;
	name: string;
	createdAt: string;
}

/** What lies on disk. Folders keep creation order (the sidebar's order). */
export interface SessionFoldersRecord {
	version: typeof CURRENT_SESSION_FOLDERS_VERSION;
	folders: SessionFolder[];
	/** chatId → folderId. May hold stale entries; readers derive. */
	assignments: Record<string, string>;
}

/** The API's view: the folders, and only the assignments that still point
 *  at a live chat and a live folder. */
export interface SessionFoldersView {
	folders: SessionFolder[];
	assignments: Record<string, string>;
}

export const EMPTY_SESSION_FOLDERS: SessionFoldersRecord = Object.freeze({
	version: CURRENT_SESSION_FOLDERS_VERSION,
	folders: [],
	assignments: {},
}) as SessionFoldersRecord;

/** session-folders.json is stamped with a newer schema than this build knows. */
export class SessionFoldersTooNew extends Error {
	constructor(readonly version: number) {
		super(`session_folders_too_new: stamped ${version} > ${CURRENT_SESSION_FOLDERS_VERSION}`);
		this.name = "SessionFoldersTooNew";
	}
}

/** The name rule, shared by the routes and the inline inputs: a string,
 *  trimmed, non-empty, at most FOLDER_NAME_MAX characters. null = invalid. */
export function normalizeFolderName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw.trim().replace(/\s+/g, " ");
	if (name === "" || [...name].length > FOLDER_NAME_MAX) return null;
	return name;
}

/** Duplicate names are refused, compared case-insensitively. */
export function folderNameTaken(folders: readonly SessionFolder[], name: string, exceptId?: string): boolean {
	const key = name.toLocaleLowerCase();
	return folders.some((f) => f.id !== exceptId && f.name.toLocaleLowerCase() === key);
}

/** The live view: assignments to a missing chat or folder are dropped. */
export function sessionFoldersView(record: SessionFoldersRecord, liveChatIds: ReadonlySet<string>): SessionFoldersView {
	const folderIds = new Set(record.folders.map((f) => f.id));
	const assignments: Record<string, string> = {};
	for (const [chatId, folderId] of Object.entries(record.assignments)) {
		if (liveChatIds.has(chatId) && folderIds.has(folderId)) assignments[chatId] = folderId;
	}
	return { folders: record.folders, assignments };
}

export type SessionKindFilter = "teach" | "all" | "practice";

export interface FolderGroup {
	folder: SessionFolder;
	/** The folder's sessions after the kind filter and the search. */
	chats: ChatListItem[];
	/** Shown expanded: not collapsed, or a search is active and it has matches. */
	expanded: boolean;
}

export interface GroupedSessions {
	folders: FolderGroup[];
	unfiled: ChatListItem[];
	/** The rows a user can see, in screen order (expanded folders, then
	 *  unfiled): the search walk and Enter index into this. */
	visible: ChatListItem[];
}

/**
 * The sidebar list, grouped. The kind filter applies inside folders (counts
 * follow it) and a search ranks titles across all folders. Without a search
 * every folder shows, empty ones included; with one, only folders with
 * matches show, and they show expanded whatever their collapsed state.
 * Assignments to unknown folders are ignored here too.
 */
export function groupSessions(
	chats: readonly ChatListItem[],
	view: SessionFoldersView | null,
	opts: { kind: SessionKindFilter; query: string; collapsed: ReadonlySet<string> },
): GroupedSessions {
	const q = opts.query.trim();
	let list = opts.kind === "all" ? [...chats] : chats.filter((c) => (c.kind ?? "teach") === opts.kind);
	if (q) {
		list = list
			.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
			.filter((r): r is { c: ChatListItem; score: number } => r.score !== null)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.c);
	}
	const folders = view?.folders ?? [];
	const known = new Set(folders.map((f) => f.id));
	const byFolder = new Map<string, ChatListItem[]>();
	const unfiled: ChatListItem[] = [];
	for (const c of list) {
		const fid = view?.assignments[c.id];
		if (fid !== undefined && known.has(fid)) {
			const bucket = byFolder.get(fid);
			if (bucket) bucket.push(c);
			else byFolder.set(fid, [c]);
		} else unfiled.push(c);
	}
	const groups: FolderGroup[] = [];
	for (const folder of folders) {
		const inside = byFolder.get(folder.id) ?? [];
		if (q && inside.length === 0) continue;
		groups.push({ folder, chats: inside, expanded: q ? true : !opts.collapsed.has(folder.id) });
	}
	const visible = [...groups.flatMap((g) => (g.expanded ? g.chats : [])), ...unfiled];
	return { folders: groups, unfiled, visible };
}

// ─── Pure edits (the server reads, applies one, writes, announces) ──────────

export type FolderRefusal = "invalid_name" | "duplicate_name" | "folder_not_found" | "chat_not_found";
export type FolderEdit = { ok: true; record: SessionFoldersRecord; folder?: SessionFolder } | { ok: false; code: FolderRefusal };

export function addFolder(record: SessionFoldersRecord, rawName: unknown, id: string, now: string): FolderEdit {
	const name = normalizeFolderName(rawName);
	if (name === null) return { ok: false, code: "invalid_name" };
	if (folderNameTaken(record.folders, name)) return { ok: false, code: "duplicate_name" };
	const folder: SessionFolder = { id, name, createdAt: now };
	return { ok: true, folder, record: { ...record, folders: [...record.folders, folder] } };
}

export function renameFolder(record: SessionFoldersRecord, id: string, rawName: unknown): FolderEdit {
	const name = normalizeFolderName(rawName);
	if (name === null) return { ok: false, code: "invalid_name" };
	const current = record.folders.find((f) => f.id === id);
	if (!current) return { ok: false, code: "folder_not_found" };
	if (folderNameTaken(record.folders, name, id)) return { ok: false, code: "duplicate_name" };
	const folder = { ...current, name };
	return { ok: true, folder, record: { ...record, folders: record.folders.map((f) => (f.id === id ? folder : f)) } };
}

/** Removes the folder and its assignments only: its sessions become unfiled. */
export function removeFolder(record: SessionFoldersRecord, id: string): FolderEdit {
	if (!record.folders.some((f) => f.id === id)) return { ok: false, code: "folder_not_found" };
	const assignments = Object.fromEntries(Object.entries(record.assignments).filter(([, fid]) => fid !== id));
	return { ok: true, record: { ...record, folders: record.folders.filter((f) => f.id !== id), assignments } };
}

/** Files a chat in a folder, or takes it out (folderId null). The caller
 *  checks that the chat exists. */
export function assignChat(record: SessionFoldersRecord, chatId: string, folderId: string | null): FolderEdit {
	const assignments = { ...record.assignments };
	if (folderId === null) delete assignments[chatId];
	else {
		if (!record.folders.some((f) => f.id === folderId)) return { ok: false, code: "folder_not_found" };
		assignments[chatId] = folderId;
	}
	return { ok: true, record: { ...record, assignments } };
}
