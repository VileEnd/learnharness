/** Drawing routes + the chat canvas setting. Isolated LH_DATA_DIR, dynamic imports. */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-drawings-routes-"));
process.env.LH_DATA_DIR = TMP;
const { stores } = await import("../src/server/stores.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { PATHS } = await import("../config.ts");
const drawings = await import("../app/api/chats/[id]/drawings/route.ts");
const one = await import("../app/api/chats/[id]/drawings/[drawingId]/route.ts");
const drafts = await import("../app/api/chats/[id]/drawings/drafts/[callId]/route.ts");
const settings = await import("../app/api/chats/[id]/settings/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const chat = stores.chatStore.createChat("t");
const scene = { version: 1, objects: [{ id: "s1", z: 0, type: "stroke", brush: "pen", color: "ink", size: 3, points: [[0, 0, 1], [4, 4, 1]] }] };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const ctx = <T extends Record<string, string> = Record<never, string>>(extra?: T) => ({ params: Promise.resolve({ id: chat.id, ...extra } as { id: string } & T) });

function submit(bytes: Uint8Array) {
	const form = new FormData();
	form.append("scene", JSON.stringify(scene));
	form.append("png", new File([bytes as BlobPart], "d.png", { type: "image/png" }));
	return drawings.POST(new Request("http://x/d", { method: "POST", body: form }), ctx());
}

it("POST rejects non-PNG bytes", async () => {
	const res = await submit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
	assert.equal(res.status, 400);
});

it("POST stores a drawing and GET png sets immutable cache", async () => {
	const res = await submit(PNG);
	assert.equal(res.status, 200);
	const { drawingId } = await res.json();
	const png = await one.GET(new Request("http://x/d?format=png"), ctx({ drawingId }));
	assert.equal(png.headers.get("content-type"), "image/png");
	assert.equal(png.headers.get("cache-control"), "private, max-age=31536000, immutable");
	const sc = await one.GET(new Request("http://x/d"), ctx({ drawingId }));
	assert.deepEqual((await sc.json()).scene, scene);
});

it("draft PUT/GET and 409 on stale baseRev", async () => {
	const put = (baseRev: number) =>
		drafts.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ scene, baseRev }) }), ctx({ callId: "call_1" }));
	assert.deepEqual(await (await put(0)).json(), { rev: 1 });
	const stale = await put(0);
	assert.equal(stale.status, 409);
	assert.equal((await stale.json()).rev, 1);
	const got = await drafts.GET(new Request("http://x"), ctx({ callId: "call_1" }));
	assert.equal((await got.json()).rev, 1);
	assert.equal((await drafts.GET(new Request("http://x"), ctx({ callId: "nope" }))).status, 404);
});

it("settings PUT preserves canvas across a model change", async () => {
	const put = (body: unknown) => settings.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), ctx());
	assert.equal((await put({ canvas: true })).status, 200);
	const model = { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" };
	const res = await put({ model });
	assert.equal(res.status, 200);
	const rec = stores.chatStore.getChat(chat.id);
	assert.equal(rec?.settings?.canvas, true);
	assert.deepEqual(rec?.settings?.model, model);
});

it("settings PUT with thinkingLevel/model null clears the pin", async () => {
	const put = (body: unknown) => settings.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), ctx());
	const model = { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" };
	assert.equal((await put({ model, thinkingLevel: "high" })).status, 200);
	assert.ok(stores.chatStore.getChat(chat.id)?.settings?.thinkingLevel);
	assert.equal((await put({ model, thinkingLevel: null })).status, 200);
	assert.equal(stores.chatStore.getChat(chat.id)?.settings?.thinkingLevel, undefined);
	assert.deepEqual(stores.chatStore.getChat(chat.id)?.settings?.model, model);
	assert.equal((await put({ model: null })).status, 200);
	const rec = stores.chatStore.getChat(chat.id)?.settings;
	assert.equal(rec?.model, undefined);
	assert.equal(rec?.canvas, true);
});

it("POST /api/chats stamps canvas", async () => {
	const res = await chatsRoute.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ canvas: true }) }));
	const { id } = await res.json();
	assert.equal(stores.chatStore.getChat(id)?.settings?.canvas, true);
});

it("deleteChatSession removes drawings", async () => {
	await submit(PNG);
	assert.equal(fs.existsSync(path.join(PATHS.drawings, chat.id)), true);
	const out = await deleteChatSession(chat.id, "preserve-graph");
	assert.equal(out.ok, true);
	assert.equal(fs.existsSync(path.join(PATHS.drawings, chat.id)), false);
});
