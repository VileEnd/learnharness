/** DrawingStore: content-addressed submissions, assets, revisioned drafts, transcripts. Isolated LH_DATA_DIR. */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import type { DrawingScene } from "../src/core/canvas-core.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-drawings-"));
process.env.LH_DATA_DIR = TMP;
const { drawingStore } = await import("../src/store/drawings.ts");
const { PATHS } = await import("../config.ts");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const scene = (n = 1): DrawingScene => ({
	version: 1,
	objects: [{ id: "s1", z: 0, type: "stroke", brush: "pen", color: "ink", size: 3, points: [[0, 0, 1], [n, n, 1]] }],
});
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

it("store construction writes nothing", () => {
	assert.equal(fs.existsSync(PATHS.drawings), false);
});

it("saveDrawing is idempotent by content", () => {
	const a = drawingStore.saveSubmission("chat_a", scene(), png);
	const b = drawingStore.saveSubmission("chat_a", scene(), png);
	assert.equal(a.drawingId, b.drawingId);
	assert.match(a.drawingId, /^drw_[0-9a-f]{12}$/);
	const jsons = fs.readdirSync(path.join(PATHS.drawings, "chat_a")).filter((f) => f.endsWith(".json"));
	assert.equal(jsons.length, 1);
	assert.deepEqual(drawingStore.getScene("chat_a", a.drawingId), scene());
	assert.deepEqual(Array.from(drawingStore.getPng("chat_a", a.drawingId) ?? []), Array.from(png));
});

it("assets round-trip with their mime type", () => {
	const { assetId } = drawingStore.saveAsset("chat_a", png, "image/png");
	assert.equal(drawingStore.getAsset("chat_a", assetId)?.mimeType, "image/png");
	assert.equal(drawingStore.getAsset("chat_a", "ast_000000000000"), null);
});

it("draft round-trips", () => {
	assert.equal(drawingStore.readDraft("chat_a", "call_1"), null);
	assert.deepEqual(drawingStore.writeDraft("chat_a", "call_1", scene(), 0), { ok: true, rev: 1 });
	assert.deepEqual(drawingStore.readDraft("chat_a", "call_1"), { scene: scene(), rev: 1 });
});

it("stale draft write is refused with the current draft", () => {
	const r = drawingStore.writeDraft("chat_a", "call_1", scene(2), 0);
	assert.equal(r.ok, false);
	if (!r.ok) assert.deepEqual(r.current, { scene: scene(), rev: 1 });
});

it("transcript round-trips", () => {
	const { drawingId } = drawingStore.saveSubmission("chat_a", scene(), png);
	assert.equal(drawingStore.readTranscript("chat_a", drawingId), null);
	drawingStore.writeTranscript("chat_a", drawingId, { model: "m", text: "t" });
	assert.deepEqual(drawingStore.readTranscript("chat_a", drawingId), { model: "m", text: "t" });
});

it("rejects traversal ids", () => {
	assert.equal(drawingStore.getScene("../x", "drw_000000000000"), null);
	assert.equal(drawingStore.getScene("chat_a", "../../etc/passwd"), null);
	assert.equal(drawingStore.getPng("chat_a", "drw_../x"), null);
	assert.equal(drawingStore.readDraft("chat_a", "../x"), null);
	assert.equal(drawingStore.getAsset("..", "ast_000000000000"), null);
});

it("deleteForChat removes the folder", () => {
	drawingStore.deleteForChat("chat_a");
	assert.equal(fs.existsSync(path.join(PATHS.drawings, "chat_a")), false);
	drawingStore.deleteForChat("../x"); // no-op, never throws
});
