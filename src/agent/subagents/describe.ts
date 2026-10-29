/**
 * The describe agent (PR G): a cheap-slot, single-submit call that names a
 * markdown document from its CONTENT - title, summary, topics. It reads the
 * first stretch of the normalised-but-not-lowercased text and is never shown
 * the filename (identity and description are content-derived end to end).
 * OCR'd PDFs already carry this in their front matter and skip the call.
 *
 * Created via createDescriber(deps) like the extraction pipeline: the
 * composition root hands in the engine resolver and the key gate.
 */

import { Type, type Static } from "typebox";
import type { ModelRole } from "../../../config.ts";
import {
	ROLE_SLOT,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	type ModelSlotName,
	type ProviderKeyMissing,
} from "../../core/settings.ts";
import type { EngineOptions, PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/** How much of the document the describer reads. */
export const DESCRIBE_CHARS = 6000;

export interface DocumentDescription {
	title: string;
	summary: string;
	topics: string[];
}

const describeSchema = Type.Object({
	title: Type.String({ description: "A short, specific title for the document, in the document's own language." }),
	summary: Type.String({ description: "Two or three sentences saying what the document teaches." }),
	topics: Type.Array(Type.String(), {
		description: "3 to 8 subject topics the document covers, each a short noun phrase in the document's language.",
	}),
});

const DESCRIBE_INSTRUCTIONS = `You describe a learning document from its content alone. You see the opening of the document; judge what it is about and submit one describe_document call: a specific title, a short summary of what it teaches, and its subject topics (short noun phrases that name the subject matter, not the document's structure). Write in the document's own language.`;

export interface DescriberDeps {
	/** The engine for the role, or undefined when the chain ends empty.
	 *  `opts` names the request-log purpose when it is not the role's
	 *  (topicist, attribution ride the describer's role). */
	engineFor: (role: ModelRole, opts?: EngineOptions) => PiEngine | undefined;
	/** Key-presence gate (the extraction pipeline's twin). */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

export interface Describer {
	describe(normalizedText: string, signal?: AbortSignal): Promise<DocumentDescription>;
}

export function createDescriber(deps: DescriberDeps): Describer {
	return {
		async describe(text, signal) {
			const engine = deps.engineFor("describer");
			if (!engine) throw new ModelsNotConfiguredError([ROLE_SLOT.describer]);
			const refusal = deps.providerKeyMissing?.(engine.model.provider, ROLE_SLOT.describer);
			if (refusal) throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
			const value = await runSubmitAgent<Static<typeof describeSchema>>({
				role: "describer",
				toolName: "describe_document",
				toolDescription: "Submit the document's title, summary and topics.",
				parameters: describeSchema,
				fill: (input) => ({
					title: String(input.title ?? "").trim(),
					summary: String(input.summary ?? "").trim(),
					topics: Array.isArray(input.topics) ? input.topics.map(String) : [],
				}),
				validate: (v) => (v.title === "" ? "title: give the document a title." : null),
				systemPrompt: DESCRIBE_INSTRUCTIONS,
				prompt: text.slice(0, DESCRIBE_CHARS),
				engine,
				signal,
				onStep: () => {},
				neverSubmitted: "The describer ended without submitting a description.",
			});
			return value;
		},
	};
}
