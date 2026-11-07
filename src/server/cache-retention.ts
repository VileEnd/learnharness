/**
 * The admin-global prompt-cache retention for conversation turns (cost knob,
 * measured with the observed cache-hit rate before it is switched): the
 * route logic. The engine side is EngineOptions.cacheRetention
 * (src/agent/models.ts), set only by the turn engine in chat-handler.ts.
 */

import { AdminPolicyCorrupt, isCacheRetentionPref } from "../core/contracts/admin.ts";
import { conversationCacheRetention, setConversationCacheRetention } from "./policy.ts";

const corrupt = () => Response.json({ error: "admin_policy_corrupt" }, { status: 500 });

/** GET /api/admin/cache-retention → {conversation: "short" | "long"}; unset reads as "short". The caller checks requireAdmin(). */
export function cacheRetentionAdminView(): Response {
	return Response.json({ conversation: conversationCacheRetention() ?? "short" });
}

/** PUT {conversation: "short" | "long"} → {conversation}. 400 on any other body; 500
 *  admin_policy_corrupt on a corrupt admin.json (never overwritten). The caller checks requireAdmin(). */
export function cacheRetentionAdminPut(raw: unknown): Response {
	const v = raw && typeof raw === "object" ? (raw as { conversation?: unknown }).conversation : undefined;
	if (!isCacheRetentionPref(v)) return Response.json({ error: 'conversation must be "short" or "long"' }, { status: 400 });
	try {
		setConversationCacheRetention(v);
	} catch (e) {
		if (e instanceof AdminPolicyCorrupt) return corrupt();
		throw e;
	}
	return cacheRetentionAdminView();
}
