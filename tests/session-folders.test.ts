/** Session folders: the store, the per-user file, and the routes (multi-user mode). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-folders-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { stores } = await import("../src/server/stores.ts");
const collection = await import("../app/api/session-folders/route.ts");
const one = await import("../app/api/session-folders/[id]/route.ts");
const move = await import("../app/api/chats/[id]/folder/route.ts");

const A = "5d1c7a3e-2b4f-4c8d-9e6a-0f1b2c3d4e5f";
const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const asUser = <T>(id: string, fn: () => T) => runAsTenant({ id, name: id, isAdmin: false }, fn);

function req(user: string, method: string, body?: unknown): Request {
	return new Request("http://example.com/x", {
		method,
		headers: { "x-auth-request-user": user, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => (await res.json()) as any;
const createFolder = async (user: string, name: string) => (await json(await collection.POST(req(user, "POST", { name })))).folder;

it("store round-trip: what is written reads back, in the user's own data dir", () => {
	const record = { version: 1 as const, folders: [{ id: "fld_0000000000000001", name: "Maths", createdAt: "2026-11-24T00:00:00.000Z" }], assignments: { chat_x: "fld_0000000000000001" } };
	asUser(A, () => stores.sessionFolderStore.writeFolders(record));
	assert.ok(fs.existsSync(path.join(dir, "users", A, "session-folders.json")));
	assert.deepEqual(asUser(A, () => stores.sessionFolderStore.readFolders()), record);
	asUser(A, () => stores.sessionFolderStore.writeFolders({ version: 1, folders: [], assignments: {} }));
});

it("two tenants never see each other's folders", async () => {
	await createFolder(A, "Physics");
	const b = await json(await collection.GET(req(B, "GET")));
	assert.deepEqual(b, { folders: [], assignments: {} });
	const a = await json(await collection.GET(req(A, "GET")));
	assert.deepEqual(a.folders.map((f: { name: string }) => f.name), ["Physics"]);
});

it("deleting a folder keeps its sessions, which become unfiled", async () => {
	const chat = asUser(A, () => stores.chatStore.createChat("Vectors"));
	const folder = await createFolder(A, "Linear algebra");
	const moved = await json(await move.PUT(req(A, "PUT", { folderId: folder.id }), ctx(chat.id)));
	assert.equal(moved.assignments[chat.id], folder.id);
	const res = await one.DELETE(req(A, "DELETE"), ctx(folder.id));
	assert.equal(res.status, 200);
	const view = await json(res);
	assert.ok(!view.folders.some((f: { id: string }) => f.id === folder.id));
	assert.equal(view.assignments[chat.id], undefined);
	assert.ok(asUser(A, () => stores.chatStore.getChat(chat.id)), "the session survives");
});

it("assignments to a missing chat or a missing folder are ignored on read", async () => {
	const chat = asUser(B, () => stores.chatStore.createChat("Kept"));
	const record = {
		version: 1 as const,
		folders: [{ id: "fld_00000000000000aa", name: "Real", createdAt: "2026-11-24T00:00:00.000Z" }],
		assignments: { [chat.id]: "fld_00000000000000aa", chat_gone: "fld_00000000000000aa", [`${chat.id}x`]: "fld_00000000000000ff" },
	};
	asUser(B, () => stores.sessionFolderStore.writeFolders(record));
	const view = await json(await collection.GET(req(B, "GET")));
	assert.deepEqual(view.assignments, { [chat.id]: "fld_00000000000000aa" });
	const onDisk = fs.readFileSync(path.join(dir, "users", B, "session-folders.json"), "utf-8");
	assert.match(onDisk, /chat_gone/, "a read never rewrites the file");
});

it("routes refuse bad input", async () => {
	const chat = asUser(A, () => stores.chatStore.createChat("Input"));
	const post = (body: unknown) => collection.POST(req(A, "POST", body));
	assert.equal((await post({ name: "   " })).status, 400);
	assert.equal((await post({ name: 7 })).status, 400);
	assert.equal((await post({ name: "x".repeat(61) })).status, 400);
	assert.equal((await post({})).status, 400);
	assert.equal((await post({ name: "  Physics " })).status, 409, "duplicate names are refused, ignoring case and spaces");
	assert.equal((await post({ name: "physics" })).status, 409);
	assert.equal((await one.PATCH(req(A, "PATCH", { name: "New" }), ctx("fld_ffffffffffffffff"))).status, 404);
	assert.equal((await one.PATCH(req(A, "PATCH", { name: "New" }), ctx("../etc"))).status, 404);
	assert.equal((await one.DELETE(req(A, "DELETE"), ctx("fld_ffffffffffffffff"))).status, 404);
	assert.equal((await move.PUT(req(A, "PUT", { folderId: 3 }), ctx(chat.id))).status, 400);
	assert.equal((await move.PUT(req(A, "PUT", {}), ctx(chat.id))).status, 400);
	assert.equal((await move.PUT(req(A, "PUT", { folderId: "fld_ffffffffffffffff" }), ctx(chat.id))).status, 404);
	assert.equal((await move.PUT(req(A, "PUT", { folderId: null }), ctx("chat_missing"))).status, 404);
	const renamed = await json(await one.PATCH(req(A, "PATCH", { name: " Mechanics " }), ctx((await createFolder(A, "Mech")).id)));
	assert.equal(renamed.folder.name, "Mechanics");
});

it("a file stamped with a newer version is refused, and never overwritten", async () => {
	const file = path.join(dir, "users", B, "session-folders.json");
	const newer = JSON.stringify({ version: 2, folders: [], assignments: {} });
	fs.writeFileSync(file, newer);
	assert.equal((await collection.GET(req(B, "GET"))).status, 409);
	assert.equal((await collection.POST(req(B, "POST", { name: "Any" }))).status, 409);
	assert.equal(fs.readFileSync(file, "utf-8"), newer);
});
