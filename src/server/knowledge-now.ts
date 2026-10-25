import { getGraph } from "../core/graph.ts";
import type { KnowledgeView } from "../core/contracts.ts";
import { buildKnowledgeOverview, checkedConceptIds, knowledgeSubgraph } from "../core/knowledge.ts";
import { graphView } from "./graph.ts";
import { learnerSnapshotNow } from "./learner-now.ts";
import { stores } from "./stores.ts";

/** The "My knowledge" view right now (GET /api/knowledge): the learner model, the overview
 *  grouped by topic, and the graph of the concepts that have evidence. A pure read. */
export function knowledgeViewNow(now: Date = new Date()): KnowledgeView {
	const learner = learnerSnapshotNow(now);
	const graph = getGraph(stores.graphStore);
	const checked = checkedConceptIds(learner.states, graph.nodes);
	const overview = buildKnowledgeOverview({
		states: learner.states,
		nodes: graph.nodes,
		topicRows: stores.graphStore.readTopics(),
		aliases: stores.graphStore.readTopicAliases(),
	});
	const view = knowledgeSubgraph(graph, checked);
	// Provenance for the detail card comes from the same snapshot the main graph serves.
	const full = graphView();
	return {
		learner,
		overview,
		graph: {
			nodes: view.nodes,
			edges: view.edges,
			logicalEdges: view.logicalEdges,
			impLinks: view.impLinks,
			sessions: full.sessions,
			fileSources: full.fileSources,
			nodeSessions: full.nodeSessions,
			documents: full.documents,
		},
	};
}
