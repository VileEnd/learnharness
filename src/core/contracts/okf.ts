/**
 * The OKF bundle's contracts (OKF v0.2, the generated library): the pure
 * renderer's input and output. Browser-safe types only; the renderer lives
 * in core/okf.ts.
 */

import type { DocumentMeta } from "./documents.ts";
import type { GraphChain, GraphNode, TopicRow } from "./graph.ts";

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

/** PLACEHOLDER (the learner model lands in a later task, which replaces this
 *  with the real snapshot). The renderer ignores it today: no me/ directory. */
export interface LearnerSnapshot {
	asOf: string;
	states: Record<string, unknown>;
}

export interface OkfInput {
	nodes: GraphNode[];
	chains: GraphChain[];
	topics: TopicRow[];
	aliases: Record<string, string>;
	documents: OkfDocumentInput[];
	chats: OkfChatInput[];
	/** Absent = no me/ directory. */
	learner?: LearnerSnapshot;
	gates: OkfGates;
	/** ISO instant; drives log.md and (later) me/ as-of. */
	now: string;
}
