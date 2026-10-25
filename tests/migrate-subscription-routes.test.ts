/**
 * The one-off subscription-route migration (browser-only build): saved
 * ChatGPT/Copilot/Grok subscription routes are rewritten to an API-key
 * model; everything else is left alone. Runs under an isolated
 * LH_DATA_DIR, set before any config-loading import (dynamic imports).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-subs-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const TARGET = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
const KEPT = { provider: "openrouter", id: "openai/gpt-6.1-sol" };

it("rewrites subscription slots and chat pins only, dry run first", async () => {
	const { writeSettings, readSettings } = await import("../src/store/settings.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { migrateSubscriptionRoutes } = await import("../scripts/migrate-subscription-routes.ts");

	writeSettings({ version: 1, models: { strong: { model: { provider: "chatgpt", id: "gpt-5.5" } }, cheap: { model: KEPT } } });
	const subscribed = chatStore.createChat("subscription chat");
	chatStore.saveSettings(subscribed.id, { model: { provider: "xai-subscription", id: "grok-5" } });
	const plain = chatStore.createChat("api chat");
	chatStore.saveSettings(plain.id, { model: KEPT });

	const dry = await migrateSubscriptionRoutes(TARGET, false);
	assert.deepEqual(dry.changes.map((c) => c.where).sort(), ["models.strong", "settings.model"]);
	assert.equal(readSettings()!.models!.strong!.model!.provider, "chatgpt", "a dry run writes nothing");

	await migrateSubscriptionRoutes(TARGET, true);
	assert.deepEqual(readSettings()!.models!.strong!.model, TARGET);
	assert.deepEqual(readSettings()!.models!.cheap!.model, KEPT);
	assert.deepEqual(chatStore.getChat(subscribed.id)!.settings!.model, TARGET);
	assert.deepEqual(chatStore.getChat(plain.id)!.settings!.model, KEPT);
	assert.ok(fs.existsSync(path.join(TMP_DATA, "settings.json.bak-subscriptions")));

	const again = await migrateSubscriptionRoutes(TARGET, true);
	assert.deepEqual(again.changes, [], "idempotent");
});
