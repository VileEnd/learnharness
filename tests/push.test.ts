/**
 * PUSH PINS (mobile E): the fs store round-trips under an isolated
 * LH_DATA_DIR (set before any config-loading import, hence the dynamic
 * imports), and notify() builds the right payload per event kind, prunes
 * dead subscriptions on 404/410, and never throws. The sender is injected,
 * so nothing here touches a network.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-push-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { pushStore } = await import("../src/store/push.ts");
const { notify, pushPublicKey, subscribe, unsubscribe } = await import("../src/server/push.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const key = { p256dh: "p", auth: "a" };

describe("push store", () => {
	it("round-trips subscriptions (upsert by endpoint) and the 0600 VAPID file", () => {
		assert.deepEqual(pushStore.listSubscriptions(), []);
		assert.equal(pushStore.readVapid(), null);
		const rec = { endpoint: "https://push.example/1", keys: key, createdAt: "t", label: "Pixel" };
		pushStore.saveSubscription(rec);
		pushStore.saveSubscription({ ...rec, label: "Pixel 2" });
		assert.deepEqual(pushStore.listSubscriptions(), [{ ...rec, label: "Pixel 2" }]);
		pushStore.removeSubscription(rec.endpoint);
		assert.deepEqual(pushStore.listSubscriptions(), []);
		pushStore.writeVapid({ publicKey: "pub", privateKey: "priv" });
		assert.deepEqual(pushStore.readVapid(), { publicKey: "pub", privateKey: "priv" });
		assert.equal(fs.statSync(path.join(TMP_DATA, "push", "vapid.json")).mode & 0o777, 0o600);
	});

	it("generates the VAPID pair once and keeps it", () => {
		fs.rmSync(path.join(TMP_DATA, "push", "vapid.json"));
		const first = pushPublicKey();
		assert.ok(first.length > 40);
		assert.equal(pushPublicKey(), first);
	});
});

describe("notify", () => {
	it("sends one payload per event kind to every device", async () => {
		subscribe({ endpoint: "https://push.example/a", keys: key }, "A");
		subscribe({ endpoint: "https://push.example/b", keys: key }, "B");
		const sent: { endpoint: string; payload: unknown }[] = [];
		const send = async (sub: { endpoint: string }, payload: string) => void sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });

		await notify({ kind: "turn", chatId: "c1", title: "Algebra" }, send);
		await notify({ kind: "job", chatId: "c1", jobKind: "research", status: "error", title: "Algebra" }, send);
		await notify({ kind: "extraction", label: "notes.md", status: "done" }, send);

		assert.equal(sent.length, 6);
		const forA = sent.filter((s) => s.endpoint.endsWith("/a")).map((s) => s.payload);
		assert.deepEqual(forA, [
			{ title: "Algebra", body: "Your teacher replied", url: "/chat/c1", tag: "chat:c1" },
			{ title: "Algebra", body: "research failed", url: "/chat/c1", tag: "chat:c1" },
			{ title: "LearnHarness", body: "notes.md: added to your graph", url: "/", tag: "extraction" },
		]);
	});

	it("prunes subscriptions on 404/410, keeps them on other failures, and never throws", async () => {
		const gone = Object.assign(new Error("gone"), { statusCode: 410 });
		const flaky = Object.assign(new Error("boom"), { statusCode: 500 });
		const send = async (sub: { endpoint: string }) => {
			if (sub.endpoint.endsWith("/a")) throw gone;
			if (sub.endpoint.endsWith("/b")) throw flaky;
		};
		const log = console.error;
		console.error = () => {};
		try {
			await notify({ kind: "turn", chatId: "c1", title: "x" }, send);
		} finally {
			console.error = log;
		}
		assert.deepEqual(pushStore.listSubscriptions().map((s) => s.endpoint), ["https://push.example/b"]);
		unsubscribe("https://push.example/b");
		assert.deepEqual(pushStore.listSubscriptions(), []);
	});
});
