import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { getGraph, graphSessionIndex, graphSessionPropositions } from "../../core/graph.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import {
	createPropositionCandidateSearch,
	propositionCandidateBatch,
	type CandidateBatch,
	type CandidateProposition,
	type CandidateRequest,
} from "../../core/proposition-candidates.ts";

/**
 * THE GRAPH TOOLS - the extraction auditor's. (The prober's names-only map
 * tools, list_sessions / list_propositions, are retired: the prober, teacher
 * and practice agents read the library, whose concepts/ files carry the
 * statements. Old transcripts keep rendering them - components/artifacts.)
 */

/** What the graph tools close over: the stores the session views read. */
export interface GraphToolContext {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

const listPropositionsInput = Type.Object({
	session: Type.String({
		minLength: 1,
		description: "The session's id exactly as list_sessions reported it (a chat id or a notes source id)",
	}),
});

// ─── the auditor's graph tools (2026-09-27 relink) ───────────────────────────

/**
 * THE AUDITOR'S TOOLSET - the extraction auditor reviews a BOUNDED, preloaded
 * candidate set instead of exploring the graph (owner ruling 2026-09-27 kept
 * the graph out of the prompt; the bounded review replaces free exploration,
 * whose cost and "never submitted" failures grew with the library):
 *
 *   find_candidates   batched, ranked lexical lookup using the proposed
 *                     findings themselves (+ their topics); five candidates
 *                     per finding, per-audit opaque cursors, full statements
 *                     and matched aliases, deduplicated within the batch.
 *   list_sessions     the birth-session index, no timestamps.
 *   list_propositions full proposition text (optional exploration fallback).
 *
 * No timestamps anywhere: identity work needs content, not chronology.
 * Read-only, pure core seams, same ports the snapshot reads.
 */

export interface AuditorCandidateBatch {
	matches: Array<{ propositionId: string; candidateIds: string[]; nextCursor: string | null }>;
	candidates: CandidateBatch["candidates"];
}

interface CandidateLookup {
	id: string;
	hints?: readonly string[];
	cursor?: string;
}

/** Prepare the first page in code, and keep all continuations bound to this
 * audit's immutable queries. A new search cannot accidentally inherit an old
 * offset. Tokens are opaque, per-audit and stable when a request is repeated;
 * none of this suppresses previously returned records. */
export function prepareAuditorReview(
	ctx: GraphToolContext,
	propositions: readonly CandidateProposition[] = [],
): {
	initialCandidates: AuditorCandidateBatch;
	tools: Record<string, AgentTool<any>>;
} {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const findInput = Type.Object(
		{
			propositions: Type.Array(
				Type.Object(
					{
						id: Type.String({ minLength: 1, description: "An id from the proposed findings. Its name, statement, aliases and topics are searched automatically." }),
						hints: Type.Optional(
							Type.Array(Type.String({ minLength: 1 }), {
								description: "Optional alternative words or phrases to add to the search. Plain text, not glob patterns.",
							}),
						),
						cursor: Type.Optional(
							Type.String({
								minLength: 1,
								description:
									"Continue a previous query with its nextCursor. Do not supply hints with a cursor; its query is already fixed. Omit cursor to start a new search at its first page.",
							}),
						),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, description: "Look up only findings needing a specific additional search. Include each id once." },
			),
		},
		{ additionalProperties: false },
	);
	let search: ReturnType<typeof createPropositionCandidateSearch> | undefined;
	const continuations = new Map<string, CandidateRequest>();
	const tokens = new Map<string, string>();
	function lookup(requests: readonly CandidateLookup[]): AuditorCandidateBatch {
		const queries = requests.map((request): CandidateRequest => {
			if (request.cursor === undefined) return { id: request.id, hints: request.hints ? [...request.hints] : undefined };
			if (request.hints !== undefined) throw new Error("A continuation already fixes its query. Omit hints, or omit cursor to start a new search.");
			const query = continuations.get(request.cursor);
			if (!query || query.id !== request.id) throw new Error("Unknown cursor for this finding and audit. Start a fresh lookup without cursor.");
			return query;
		});
		search ??= createPropositionCandidateSearch(getGraph(deps.graphStore).nodes);
		const batch = propositionCandidateBatch(search, propositions, queries);
		return {
			matches: batch.matches.map((match, index) => {
				let nextCursor: string | null = null;
				if (match.nextOffset !== null) {
					const query = { ...queries[index]!, offset: match.nextOffset };
					const key = JSON.stringify([query.id, query.hints ?? [], query.offset]);
					nextCursor = tokens.get(key) ?? randomUUID();
					tokens.set(key, nextCursor);
					continuations.set(nextCursor, query);
				}
				return { propositionId: match.propositionId, candidateIds: match.candidateIds, nextCursor };
			}),
			candidates: batch.candidates,
		};
	}
	const initialCandidates = lookup([...new Set(propositions.map((proposition) => proposition.id))].map((id) => ({ id })));
	const tools: Record<string, AgentTool<any>> = {
		find_candidates: {
			name: "find_candidates",
			label: "find_candidates",
			description:
				"Find existing proposition candidates for a batch of proposed ids, using their full text and optional hints. " +
				"Ranks word overlap across names, statements and aliases, not exact phrases or glob patterns. " +
				"The first page is already in your input. A new search returns five ranked candidates; nextCursor continues that exact query. " +
				"Each candidate's full statement and relevant matched aliases appear once in candidates; matches lists its ids per finding. " +
				"An unmatched finding can remain new; a continuation is an option, not a requirement to keep searching. " +
				"There is no cross-call suppression: repeating a request returns its full page again.",
			parameters: findInput,
			execute: serverExecute("find_candidates", findInput, async (input) => lookup(input.propositions)),
		},
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the knowledge graph's birth sessions — every chat or imported-notes file that ever contributed a proposition. " +
				"Each line: name, kind, proposition count, id. Use the id with list_propositions to see what a session covered.",
			parameters: Type.Object({}),
			execute: serverExecute("list_sessions", Type.Object({}), async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) => `${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}) — id: ${s.id}`);
				return `${sessions.length} session(s):\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one session, with FULL statement text — the content-level view for identity work " +
				"(deciding whether a new proposition is really one of these).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				const nodes = new Map(getGraph(deps.graphStore).nodes.map((n) => [n.id, n]));
				const lines = propositions.map((p) => {
					const node = nodes.get(p.nodeId);
					return `- ${p.nodeId} :: ${p.name}\n  statement: ${node?.statement ?? "(unknown)"}`;
				});
				return `${propositions.length} proposition(s) born in this session:\n${lines.join("\n")}`;
			}),
		},
	};
	return { initialCandidates, tools };
}
