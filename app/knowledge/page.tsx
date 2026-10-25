import { KnowledgeView } from "@/components/knowledge-view";

// Client-fetched (GET /api/knowledge), live-updated: nothing to read on the server.
export default function KnowledgePage() {
	return <KnowledgeView />;
}
