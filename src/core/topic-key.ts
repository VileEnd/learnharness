/**
 * The matching key of a topic: trimmed, whitespace-collapsed, NFKC,
 * case-folded. Pure and browser-safe (the chain table groups by it too);
 * core/documents.ts re-exports it for the server side.
 */
export function topicKey(topic: string): string {
	return topic.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
