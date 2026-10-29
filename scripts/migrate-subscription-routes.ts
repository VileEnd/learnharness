/**
 * migrate-subscription-routes.ts — one-off rewrite for data dirs that came
 * from the desktop app, where a model could be a ChatGPT / Copilot / Grok
 * SUBSCRIPTION route. The browser-only build has no subscription
 * connections, so every saved reference to one is rewritten to an
 * API-key model the user picks:
 *
 *   - settings.json: the strong/cheap/vision slots and the per-role
 *     background overrides (agent.models)
 *   - every chat's own model pin (chat.settings.model)
 *
 * Thinking-level pins are clamped to the new model (the same clamp the
 * settings routes apply). Turn usage history and transcripts are NOT
 * touched — old subscription turns simply render as unpriced.
 *
 *   LH_DATA_DIR=<dir> npx tsx scripts/migrate-subscription-routes.ts --to <provider>/<modelId>          # dry run
 *   LH_DATA_DIR=<dir> npx tsx scripts/migrate-subscription-routes.ts --to <provider>/<modelId> --write  # apply
 *
 * --write copies each touched file to <file>.bak-subscriptions first.
 * Writes go through the real store adapters, so schema stamps stay right.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SUBSCRIPTION_PROVIDERS = new Set(["chatgpt", "github-copilot-subscription", "xai-subscription"]);

type ModelRef = { provider: string; id: string };
type Pinned = { model?: ModelRef; thinkingLevel?: string };

export interface RouteChange {
	file: string;
	where: string;
	from: string;
	to: string;
}

export interface MigrationResult {
	changes: RouteChange[];
	written: boolean;
}

const isSubscription = (pin: Pinned | undefined): boolean =>
	pin?.model !== undefined && SUBSCRIPTION_PROVIDERS.has(pin.model.provider);

const label = (model: ModelRef): string => `${model.provider}/${model.id}`;

export function parseTarget(value: string | undefined): ModelRef {
	const slash = value?.indexOf("/") ?? -1;
	if (!value || slash <= 0 || slash === value.length - 1) {
		throw new Error("--to <provider>/<modelId> is required (e.g. --to anthropic/claude-sonnet-5-5)");
	}
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** Rewrite every subscription route under LH_DATA_DIR (read at import time
 *  of the stores — set it before calling). Dry run unless `write`. */
export async function migrateSubscriptionRoutes(target: ModelRef, write: boolean): Promise<MigrationResult> {
	const { PATHS, settingsFile } = await import("../config.ts");
	const { readSettings, writeSettings } = await import("../src/store/settings.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { validateChatSettings, clampChatLevel, clampModelsLevels } = await import("../src/server/model-catalog.ts");

	const verdict = validateChatSettings({ model: target });
	if (!verdict.ok) throw new Error(`--to ${label(target)}: ${verdict.error}`);

	const changes: RouteChange[] = [];
	const backup = (file: string) => {
		const copy = `${file}.bak-subscriptions`;
		if (!fs.existsSync(copy)) fs.copyFileSync(file, copy);
	};

	// ── settings.json: slots + background-role overrides ────────────────────
	const settings = readSettings();
	if (settings) {
		const settingsRel = path.relative(PATHS.data, settingsFile());
		let touched = false;
		const models = { ...(settings.models ?? {}) } as Record<string, Pinned>;
		for (const [slot, pin] of Object.entries(models)) {
			if (!isSubscription(pin)) continue;
			changes.push({ file: settingsRel, where: `models.${slot}`, from: label(pin.model!), to: label(target) });
			models[slot] = { ...pin, model: target };
			touched = true;
		}
		const roles = { ...(settings.agent?.models ?? {}) } as Record<string, Pinned>;
		for (const [role, pin] of Object.entries(roles)) {
			if (!isSubscription(pin)) continue;
			changes.push({ file: settingsRel, where: `agent.models.${role}`, from: label(pin.model!), to: label(target) });
			roles[role] = clampChatLevel({ ...pin, model: target } as never, null) as Pinned;
			touched = true;
		}
		if (touched && write) {
			backup(settingsFile());
			writeSettings({
				...settings,
				models: clampModelsLevels(models as never),
				...(settings.agent ? { agent: { ...settings.agent, models: roles } } : {}),
			});
		}
	}

	// ── chats: each session's own model pin ─────────────────────────────────
	for (const summary of chatStore.listChats()) {
		const record = chatStore.getChat(summary.id);
		const pin = record?.settings as Pinned | undefined;
		if (!record || !isSubscription(pin)) continue;
		const file = path.join(PATHS.chats, `${record.id}.json`);
		changes.push({ file: path.relative(PATHS.data, file), where: "settings.model", from: label(pin!.model!), to: label(target) });
		if (write) {
			backup(file);
			chatStore.saveSettings(record.id, clampChatLevel({ ...record.settings, model: target }, null));
		}
	}

	return { changes, written: write };
}

async function main() {
	const args = process.argv.slice(2);
	const toIndex = args.indexOf("--to");
	const target = parseTarget(toIndex >= 0 ? args[toIndex + 1] : undefined);
	const write = args.includes("--write");
	if (!process.env.LH_DATA_DIR) {
		console.warn("[migrate] LH_DATA_DIR is not set — using the repo's data/ directory.");
	}
	const { changes } = await migrateSubscriptionRoutes(target, write);
	for (const c of changes) console.log(`${c.file}  ${c.where}: ${c.from} → ${c.to}`);
	if (changes.length === 0) console.log("[migrate] no subscription routes found — nothing to do.");
	else if (write) console.log(`[migrate] rewrote ${changes.length} route(s); backups: *.bak-subscriptions`);
	else console.log(`[migrate] dry run: ${changes.length} route(s) would change. Re-run with --write to apply.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
	main().catch((err) => {
		console.error(`[migrate] ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	});
}
