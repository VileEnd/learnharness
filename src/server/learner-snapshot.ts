/**
 * THE learner-snapshot seam: the learner model at an instant - evidence from
 * every chat + the attribution ledger, folded into a state per concept. One
 * builder for both consumers (the OKF bundle's me/ pages and GET /api/learner),
 * so they can never disagree. Pure over the ports it is handed.
 */

import type { LearnerSnapshot } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import { deriveEvidence, deriveLearnerState } from "../core/learner.ts";
import type { ChatStore, LearnerStore } from "../core/ports.ts";

export interface LearnerSnapshotDeps {
	chatStore: Pick<ChatStore, "listChats" | "getChat">;
	learnerStore: Pick<LearnerStore, "readAttributions">;
}

export function buildLearnerSnapshot(
	deps: LearnerSnapshotDeps,
	graph: Pick<ReturnType<typeof getGraph>, "nodes" | "chains">,
	now: Date,
): LearnerSnapshot {
	const nodeIds = [...new Set(graph.nodes.map((n) => n.id))];
	const chats = deps.chatStore.listChats().flatMap((c) => deps.chatStore.getChat(c.id) ?? []);
	const events = deriveEvidence(chats, deps.learnerStore.readAttributions(), new Set(nodeIds));
	return deriveLearnerState(events, graph.chains, nodeIds, now);
}
