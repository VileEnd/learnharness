/**
 * Claude Code as an admin-only provider (experiment): the gate rule, the
 * runner status and the admin toggle's route logic. The provider source the
 * composition root installs is in claude-code-engine.ts. The engine itself lives in
 * src/agent/claude-code/ and reaches the CLI only through the runner in the
 * `claude` container (CLAUDE_RUNNER_ADDR / CLAUDE_RUNNER_TOKEN).
 *
 * The gate admits a claude-code spec only for the admin's own chat turns, and
 * only while the admin toggle is on (off by default, read fresh per call).
 */

import type { EngineOptions, ResolvedModelSpec } from "../agent/models.ts";
import { runnerStatus, type RunnerAddress } from "../agent/claude-code/runner-client.ts";
import { AdminPolicyCorrupt, modelKey } from "../core/contracts/admin.ts";
import { CLAUDE_CODE_MINIMUM_VERSION, CLAUDE_CODE_PROVIDER, type ClaudeCodeStatus } from "../core/contracts/claude-code.ts";
import { ModelNotAllowedError } from "../core/settings.ts";
import { multiUser, requireTenant } from "../core/tenant-context.ts";
import { claudeCodeEnabled, setClaudeCodeEnabled } from "./policy.ts";

/** The turn engine's purposes (src/server/chat-handler.ts): the only engines
 *  a claude-code spec may build. */
const TURN_PURPOSES: ReadonlySet<string> = new Set(["teacher", "prober", "practice"]);

/** The refusal for a claude-code spec, else null (any other provider, or an
 *  admitted turn). Refused unless the toggle is on, the caller is an admin
 *  (single-user mode counts as admin), and the engine is a chat turn: a chat
 *  id, no role, a turn purpose. Compaction, role engines, jobs, extraction and
 *  every other background engine are refused. A refusal, never a substitute:
 *  a pinned chat must not run silently on another model. */
export function claudeCodeRefusal(spec: ResolvedModelSpec, opts: EngineOptions): Error | null {
	if (spec.provider !== CLAUDE_CODE_PROVIDER) return null;
	const admin = !multiUser() || requireTenant().isAdmin;
	const turn = opts.chatId !== undefined && opts.chatId !== "" && opts.role === undefined && opts.purpose !== undefined && TURN_PURPOSES.has(opts.purpose);
	if (admin && turn && claudeCodeEnabled()) return null;
	return new ModelNotAllowedError(modelKey(spec));
}

/** The runner's address and token from the environment, or null when either is unset. */
export function runnerAddress(): RunnerAddress | null {
	const addr = process.env.CLAUDE_RUNNER_ADDR;
	const token = process.env.CLAUDE_RUNNER_TOKEN;
	return addr && token ? { addr, token } : null;
}

/** The CLI's install state as the runner reports it; not-configured without a runner address and token. */
export function claudeCodeStatus(): Promise<ClaudeCodeStatus> {
	const runner = runnerAddress();
	if (!runner) return Promise.resolve({ state: "not-configured", version: null, minimumVersion: CLAUDE_CODE_MINIMUM_VERSION });
	return runnerStatus(runner);
}

const corrupt = () => Response.json({ error: "admin_policy_corrupt" }, { status: 500 });

/** GET /api/admin/claude-code → {enabled, status}. The caller checks requireAdmin(). */
export async function claudeCodeAdminView(): Promise<Response> {
	return Response.json({ enabled: claudeCodeEnabled(), status: await claudeCodeStatus() });
}

/** PUT /api/admin/claude-code {enabled: boolean} → {enabled}. 400 on any other
 *  body; 500 admin_policy_corrupt on a corrupt admin.json (never overwritten).
 *  The caller checks requireAdmin(). */
export function claudeCodeAdminPut(raw: unknown): Response {
	const enabled = raw && typeof raw === "object" ? (raw as { enabled?: unknown }).enabled : undefined;
	if (typeof enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
	try {
		setClaudeCodeEnabled(enabled);
	} catch (e) {
		if (e instanceof AdminPolicyCorrupt) return corrupt();
		throw e;
	}
	return Response.json({ enabled: claudeCodeEnabled() });
}
