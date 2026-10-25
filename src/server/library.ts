/**
 * The app's ONE document service - the composition root for the library
 * (stores + the shared extraction pipeline + the describe agent + the OCR
 * client + push). Kept apart from documents.ts so the service itself stays
 * constructible with stubs in tests.
 */

import { createDescriber } from "../agent/subagents/describe.ts";
import { extraction, resolveEngine } from "./chat-handler.ts";
import type { DocumentStore } from "../core/ports.ts";
import { docIndex } from "./doc-index.ts";
import { createDocumentService } from "./documents.ts";
import { providerKeyPresent } from "./keys.ts";
import { providerKeyMissing } from "../core/settings.ts";
import { ocr } from "./ocr-client.ts";
import { notify } from "./push.ts";
import { stores } from "./stores.ts";

const describer = createDescriber({
	// BYOK: role override -> cheap slot -> nothing (read fresh per call).
	engineFor: resolveEngine,
	providerKeyMissing: (provider, tier) => (providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier])),
});

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
	ocr,
	notify: (event) => notify(event),
});
