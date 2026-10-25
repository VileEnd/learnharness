import { graphView } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	// ?groupBy=source|topic - the client's current grouping (a render
	// setting); absent = the saved setting.
	const raw = new URL(request.url).searchParams.get("groupBy");
	return Response.json(graphView(raw === "topic" || raw === "source" ? raw : undefined));
}
