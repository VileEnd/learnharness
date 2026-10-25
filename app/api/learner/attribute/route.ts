/**
 * POST /api/learner/attribute - the one-off admin action that links every
 * teaching chat's pending graded questions to library concepts (the same
 * attribution the app runs after turns, for sessions that predate it). Runs to
 * completion as one activity row and answers {chats, rows}; a second call
 * finds nothing to do ({chats: 0, rows: 0}). Never called by the app itself.
 */
import { attribution, withActivityRow } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	const result = await withActivityRow("learner-attribution", "Linking answers to concepts", () => attribution.attributePending());
	return Response.json(result);
}
