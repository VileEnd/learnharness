/** The sidebar list with folders: a folder, an unfiled session, the kind filter applied. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionList } from "../components/sidebar.tsx";
import { groupSessions, type ChatListItem, type SessionFoldersView } from "../src/core/index.ts";

const chat = (id: string, title: string, kind: "teach" | "practice", pendingQuestion = false): ChatListItem => ({
	id,
	title,
	kind,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	messageCount: 2,
	phase: "teach",
	pendingQuestion,
	pendingProblem: false,
	busy: false,
	compacting: false,
});
const chats = [chat("c1", "Eigenvalues", "teach", true), chat("c2", "Matrix drills", "practice"), chat("c3", "Thermodynamics", "teach")];
const view: SessionFoldersView = {
	folders: [
		{ id: "fld_00000000000000a1", name: "Linear algebra", createdAt: "2026-11-01T00:00:00.000Z" },
		{ id: "fld_00000000000000a2", name: "Later", createdAt: "2026-11-01T00:00:00.000Z" },
	],
	assignments: { c1: "fld_00000000000000a1", c2: "fld_00000000000000a1" },
};
const noop = () => {};
const on = { open: noop, rowMenu: noop, rowContext: noop, commitRename: noop, cancelRename: noop, toggleFolder: noop, folderMenu: noop, folderContext: noop, commitFolderName: noop, cancelFolderName: noop };
const render = (kind: "teach" | "all" | "practice", query = "", collapsed = new Set<string>()) =>
	renderToStaticMarkup(
		<SessionList grouped={groupSessions(chats, view, { kind, query, collapsed })} query={query} compact pathname="/" kbdIndex={null} renamingId={null} renamingFolderId={null} creatingFolder={false} on={on} />,
	);

it("folders come first with their filtered count, the empty one included, then the unfiled session", () => {
	const html = render("teach");
	const order = ["Linear algebra", "Eigenvalues", "Later", "Thermodynamics"].map((t) => html.indexOf(t));
	assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)), `order: ${order}`);
	assert.doesNotMatch(html, /Matrix drills/, "the practice session is filtered out inside its folder");
	assert.deepEqual([...html.matchAll(/data-testid="session-folder-count"[^>]*>(\d+)</g)].map((m) => m[1]), ["1", "0"]);
	assert.match(html, /data-testid="session-status-dot"/, "a filed compact row keeps its status dot");
});

it("a collapsed folder hides its rows; a search shows only folders with matches, expanded", () => {
	const folded = render("all", "", new Set(["fld_00000000000000a1"]));
	assert.doesNotMatch(folded, /Eigenvalues/);
	assert.match(folded, /aria-expanded="false"/);
	const searched = render("all", "drills", new Set(["fld_00000000000000a1"]));
	assert.match(searched, /Matrix drills/);
	assert.doesNotMatch(searched, /Later|Thermodynamics|Eigenvalues/);
});
