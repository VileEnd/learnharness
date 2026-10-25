/**
 * The OKF bundle's contracts (OKF v0.2, the generated library): the pure
 * renderer's input and output. Browser-safe types only; the renderer lives
 * in core/okf.ts.
 */

import type { DocumentMeta } from "./documents.ts";
import type { GraphChain, GraphNode, TopicRow } from "./graph.ts";
import type { LearnerSnapshot } from "./learner.ts";

export type { LearnerSnapshot };

/** One file of the bundle: a POSIX path relative to the bundle root + its text. */
export interface OkfFile {
	path: string;
	content: string;
}

/** Which parts of the library the bundle may contain (the settings gates). */
export interface OkfGates {
	documents: boolean;
	graph: boolean;
}

/** A stored document: its meta and the markdown (document.md) the section offsets slice. */
export interface OkfDocumentInput {
	meta: DocumentMeta;
	/** document.md - sections are sliced with text.slice(section.start, section.end). */
	text: string;
}

export interface OkfChatInput {
	id: string;
	title: string;
	createdAt: string;
}

export interface OkfInput {
	nodes: GraphNode[];
	chains: GraphChain[];
	topics: TopicRow[];
	aliases: Record<string, string>;
	documents: OkfDocumentInput[];
	chats: OkfChatInput[];
	/** Ids of the registered imported-notes sources (GraphStore.readSources); absent = none. */
	noteSources?: string[];
	/** Absent = no me/ directory. */
	learner?: LearnerSnapshot;
	gates: OkfGates;
	/** ISO instant; drives log.md and the me/ as-of line. */
	now: string;
}
