/**
 * Claude Code's engine half: the composition root (src/server/stores.ts)
 * installs a provider source that registers the `claude-code` provider in the
 * process-wide piModels() collection. Kept apart from claude-code.ts (which
 * the model gate imports) so the install never runs inside that module's
 * import cycle with stores.ts, the custom-provider-engine.ts precedent: only
 * stores.ts imports this module.
 */

import { addProviderSource } from "../agent/models.ts";
import { createClaudeCodeProvider } from "../agent/claude-code/provider.ts";
import { createRunnerClient } from "../agent/claude-code/runner-client.ts";
import { createClaudeCodeStreamFunction } from "../agent/claude-code/stream.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import { runnerAddress } from "./claude-code.ts";
import { claudeCodeEnabled } from "./policy.ts";

/** Install the Claude Code provider source. Every piModels() call registers
 *  the provider while the toggle is on and a runner is configured, and
 *  deletes it otherwise; it is rebuilt only when that view changes. The
 *  provider only makes the models resolvable: the gate decides who may use them. */
export function installClaudeCodeSource(): void {
	let fingerprint: string | undefined;
	addProviderSource({
		id: CLAUDE_CODE_PROVIDER,
		isCustom: () => false,
		isPriced: () => false,
		sync(models) {
			const runner = claudeCodeEnabled() ? runnerAddress() : null;
			const next = runner ? JSON.stringify(runner) : ""; // private, in memory only
			if (next === fingerprint) return;
			if (runner) models.setProvider(createClaudeCodeProvider(createClaudeCodeStreamFunction(createRunnerClient(runner))));
			else models.deleteProvider(CLAUDE_CODE_PROVIDER);
			fingerprint = next;
		},
	});
}
