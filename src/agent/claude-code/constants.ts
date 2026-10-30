export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";

export const CLAUDE_CODE_API = "claude-code-cli";

export const CLAUDE_CODE_NOT_SIGNED_IN_COPY = "Claude Code isn't signed in. Run `docker exec -it learnharness-claude-1 claude` on the server and use /login.";

export const CLAUDE_CODE_UNREACHABLE_COPY = "Claude Code isn't reachable. Check the claude container.";

/** A launch failure whose message is readable copy, shown to the learner as is. */
export class ClaudeLaunchError extends Error {}
