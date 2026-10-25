/**
 * The app's ONE document service - the composition root for the library
 * (stores + the shared extraction pipeline + the describe agent + the OCR
 * client + push). Kept apart from documents.ts so the service itself stays
 * constructible with stubs in tests.
 */

import { createDescriber } from "../agent/subagents/describe.ts";
import { extraction, resolveEngine } from "./chat-handler.ts";
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

export const documents = createDocumentService({
	store: stores.documentStore,
	// Looked up per call: tests and dev swap extraction.importNotes on the shared instance.
	importNotes: (input) => extraction.importNotes(input),
	describe: (text, signal) => describer.describe(text, signal),
	ocr,
	notify: (event) => notify(event),
});
