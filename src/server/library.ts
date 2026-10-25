/**
 * The app's ONE document service - the composition root for the library
 * (stores + the shared extraction pipeline + the describe agent + the OCR
 * client + push). Kept apart from documents.ts so the service itself stays
 * constructible with stubs in tests.
 */

import { createDescriber } from "../agent/subagents/describe.ts";
import { createTopicist } from "../agent/subagents/topics.ts";
import { extraction, resolveEngine } from "./chat-handler.ts";
import type { DocumentStore } from "../core/ports.ts";
import { docIndex } from "./doc-index.ts";
import { createDocumentService } from "./documents.ts";
import { providerKeyPresent } from "./keys.ts";
import { providerKeyMissing } from "../core/settings.ts";
import { ocr } from "./ocr-client.ts";
import { notify } from "./push.ts";
import { stores } from "./stores.ts";

const cheapDeps = {
	// BYOK: role override -> cheap slot -> nothing (read fresh per call).
	engineFor: resolveEngine,
	providerKeyMissing: (provider: string, tier: Parameters<typeof providerKeyMissing>[1][number]) =>
		providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier]),
};
const describer = createDescriber(cheapDeps);
// The topic canonicaliser and tagger ride the describer's cheap-slot role.
const topicist = createTopicist(cheapDeps);

/** The store the service writes through: every save/remove also updates the
 *  search index (BM25 now, embeddings in the background - PR I). */
const indexedStore: DocumentStore = {
	...stores.documentStore,
	save(meta, markdown) {
		stores.documentStore.save(meta, markdown);
		docIndex.indexDocument(meta.id);
	},
	remove(id) {
		const removed = stores.documentStore.remove(id);
		docIndex.removeDocument(id);
		return removed;
	},
};

export const documents = createDocumentService({
	store: indexedStore,
	// Looked up per call: tests and dev swap extraction.importNotes on the shared instance.
	importNotes: (input) => extraction.importNotes(input),
	describe: (text, signal) => describer.describe(text, signal),
	graph: stores.graphStore,
	canonicalize: (topics, existing, signal) => topicist.canonicalize(topics, existing, signal),
	tagNodes: (topics, nodes, signal) => topicist.tagNodes(topics, nodes, signal),
	applyTopicRows: (input) => extraction.applyTopicRows(input),
	ocr,
	notify: (event) => notify(event),
});
