export const CLAUDE_CODE_PROVIDER = "claude-code";

/**
 * Installation/version only. Never an authentication, quota, or billing verdict.
 * "not-configured": the app has no runner address/token; "not-found": the runner
 * can't be reached, refuses, or has no CLI.
 */
export interface ClaudeCodeStatus {
	state: "not-configured" | "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

// --permission-prompts none was added in 2.1.259. This is not an official
// minimum-version/stability contract for claudecode/toolUseId; admission fails closed.
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.259";
