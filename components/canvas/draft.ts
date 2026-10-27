/**
 * Canvas draft persistence (pure + a guarded localStorage mirror). The server
 * keeps the working scene per task call (`PUT drafts/<callId>`, revisioned);
 * every autosave is also mirrored to localStorage so going offline mid-task
 * loses nothing. On open the NEWER of the two wins.
 */
import type { DrawingScene } from "@/src/core";

export type ServerDraft = { scene: DrawingScene; rev: number };
/** The local mirror: `rev` is the server revision the scene was based on;
 *  `dirty` means edits not yet acknowledged by the server. */
export type LocalDraft = { scene: DrawingScene; rev: number; dirty: boolean };

export function localDraftKey(chatId: string, callId: string): string {
	return `lh:draft:${chatId}:${callId}`;
}

/** The newer of server and local. Unacknowledged local edits on top of the
 *  server's current revision (or a revision the server never reached) win;
 *  a server that moved on (another device) wins. */
export function pickDraft(server: ServerDraft | null, local: LocalDraft | null): { scene: DrawingScene; rev: number; from: "server" | "local" } | null {
	if (!server && !local) return null;
	if (!local) return { scene: server!.scene, rev: server!.rev, from: "server" };
	if (!server) return { scene: local.scene, rev: local.rev, from: "local" };
	if (local.dirty && local.rev >= server.rev) return { scene: local.scene, rev: server.rev, from: "local" };
	return { scene: server.scene, rev: server.rev, from: "server" };
}

export function readLocalDraft(chatId: string, callId: string): LocalDraft | null {
	try {
		const raw = window.localStorage.getItem(localDraftKey(chatId, callId));
		if (!raw) return null;
		const d = JSON.parse(raw) as Partial<LocalDraft>;
		if (!d || typeof d.rev !== "number" || typeof d.dirty !== "boolean" || !d.scene || d.scene.version !== 1 || !Array.isArray(d.scene.objects)) return null;
		return { scene: d.scene, rev: d.rev, dirty: d.dirty };
	} catch {
		return null;
	}
}

export function writeLocalDraft(chatId: string, callId: string, draft: LocalDraft): void {
	try {
		window.localStorage.setItem(localDraftKey(chatId, callId), JSON.stringify(draft));
	} catch {
		/* quota, private window: the server draft is the primary copy */
	}
}

export function clearLocalDraft(chatId: string, callId: string): void {
	try {
		window.localStorage.removeItem(localDraftKey(chatId, callId));
	} catch {
		/* nothing to clear */
	}
}
