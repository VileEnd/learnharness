import { getGraph } from "../core/graph.ts";
import type { LearnerSnapshot } from "../core/contracts.ts";
import { buildLearnerSnapshot } from "./learner-snapshot.ts";
import { stores } from "./stores.ts";

/** The learner model right now, from the wired stores (GET /api/learner). A pure read.
 *  Kept apart from learner-snapshot.ts so that builder stays constructible with stubs. */
export function learnerSnapshotNow(now: Date = new Date()): LearnerSnapshot {
	return buildLearnerSnapshot(stores, getGraph(stores.graphStore), now);
}
