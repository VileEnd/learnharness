import { getGraph } from "../core/graph.ts";
import type { LearnerView } from "../core/contracts.ts";
import { buildLearnerSnapshot } from "./learner-snapshot.ts";
import { stores } from "./stores.ts";

/** The learner model right now, from the wired stores (GET /api/learner), with the titles of
 *  the sessions its evidence cites. A pure read.
 *  Kept apart from learner-snapshot.ts so that builder stays constructible with stubs. */
export function learnerSnapshotNow(now: Date = new Date()): LearnerView {
	const snapshot = buildLearnerSnapshot(stores, getGraph(stores.graphStore), now);
	const cited = new Set<string>();
	for (const s of Object.values(snapshot.states)) for (const e of s.history) cited.add(e.chatId);
	const sessions: Record<string, string> = {};
	for (const c of stores.chatStore.listChats()) if (cited.has(c.id) && c.title) sessions[c.id] = c.title;
	return { ...snapshot, sessions };
}
