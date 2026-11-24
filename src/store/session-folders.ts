/**
 * The SessionFolderStore adapter: <userDataRoot()>/session-folders.json
 * (config.sessionFoldersFile(), per tenant through the ambient scope).
 * Replace-whole, written crash-safe (atomic-write.ts), the settings store's
 * idiom. Reads never write.
 *
 *  - absent or unparseable → the empty record (first-use semantics; the
 *    settings precedent for a small presentation file);
 *  - stamped with a newer `version` → SessionFoldersTooNew, so a read and
 *    every read-modify-write refuse and an older build never overwrites it;
 *  - entries of the wrong shape are dropped on read.
 */

import fs from "node:fs";
import path from "node:path";
import { sessionFoldersFile } from "../../config.ts";
import type { SessionFolderStore } from "../core/ports.ts";
import {
	CURRENT_SESSION_FOLDERS_VERSION,
	EMPTY_SESSION_FOLDERS,
	SessionFoldersTooNew,
	type SessionFolder,
	type SessionFoldersRecord,
} from "../core/session-folders.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function isFolder(v: unknown): v is SessionFolder {
	const f = v as Partial<SessionFolder> | null;
	return !!f && typeof f === "object" && typeof f.id === "string" && typeof f.name === "string" && typeof f.createdAt === "string";
}

function readFolders(): SessionFoldersRecord {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(sessionFoldersFile(), "utf-8"));
	} catch {
		return EMPTY_SESSION_FOLDERS;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SESSION_FOLDERS;
	const r = raw as { version?: unknown; folders?: unknown; assignments?: unknown };
	if (typeof r.version === "number" && r.version > CURRENT_SESSION_FOLDERS_VERSION) throw new SessionFoldersTooNew(r.version);
	const folders = Array.isArray(r.folders) ? r.folders.filter(isFolder).map(({ id, name, createdAt }) => ({ id, name, createdAt })) : [];
	const assignments: Record<string, string> = {};
	if (r.assignments && typeof r.assignments === "object" && !Array.isArray(r.assignments)) {
		for (const [chatId, folderId] of Object.entries(r.assignments)) if (typeof folderId === "string") assignments[chatId] = folderId;
	}
	return { version: CURRENT_SESSION_FOLDERS_VERSION, folders, assignments };
}

function writeFolders(record: SessionFoldersRecord): void {
	const file = sessionFoldersFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const out: SessionFoldersRecord = { version: CURRENT_SESSION_FOLDERS_VERSION, folders: record.folders, assignments: record.assignments };
	writeFileAtomicSync(file, `${JSON.stringify(out, null, "\t")}\n`);
}

export const sessionFolderStore: SessionFolderStore = { readFolders, writeFolders };
