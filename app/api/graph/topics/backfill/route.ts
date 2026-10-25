/**
 * POST /api/graph/topics/backfill - the one-off admin action that files every
 * concept without a topic row (concepts born in teaching sessions before they
 * carried topics) under 1-3 topics. Runs in the background as one activity
 * row, in chunks of 80 nodes on the cheap model; answers 202 at once with how
 * many nodes it is working on, or 200 {pending: 0} when there is nothing left
 * (a second call tags 0). Never called by the app itself.
 */
import { topicBackfill } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	const started = topicBackfill.start();
	if (started.pending === 0) return Response.json({ started: false, pending: 0 });
	return Response.json({ started: !started.running, running: started.running, pending: started.pending }, { status: 202 });
}
