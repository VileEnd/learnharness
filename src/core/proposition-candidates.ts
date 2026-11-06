import type { GraphNode } from "./contracts/graph.ts";
import { tokenize } from "./doc-search.ts";

/** Retrieval only: scores rank lexical candidates, never decide identity. */
export interface CandidateProposition {
	id: string;
	name: string;
	statement: string;
	aliases: readonly string[];
	/** The finding's own topics: automatic query hints (vocabulary only). */
	topics?: readonly string[];
}

export interface CandidateRequest {
	id: string;
	hints?: readonly string[];
	offset?: number;
}

export interface CandidateBatch {
	matches: Array<{
		propositionId: string;
		candidateIds: string[];
		offset: number;
		totalCandidates: number;
		hasMore: boolean;
		nextOffset: number | null;
	}>;
	candidates: Array<{
		id: string;
		name: string;
		statement: string;
		matchedAliases: string[];
		sessions: string[];
	}>;
}

export const CANDIDATE_PAGE_SIZE = 5;

const K1 = 1.2;
const B = 0.75;

interface TextIndex {
	terms: Map<string, number>;
	length: number;
	alias?: string;
}

function indexText(text: string, alias?: string): TextIndex {
	const tokens = tokenize(text);
	const terms = new Map<string, number>();
	for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
	return { terms, length: tokens.length, alias };
}

/** One immutable, in-memory index per audit, over the fork's own German/English
 * tokenizer (umlaut folding, light stemming, whole math tokens). Each canonical
 * and alias phrasing is scored separately (best one wins) so a node is not
 * penalized for accumulating aliases. Document frequency counts NODES, not
 * phrasings. BM25 with k1=1.2, b=0.75; query terms are a union. Hints (and the
 * finding's topics) add vocabulary to the actual proposition, never replace it.
 * No network, embeddings, cache or equivalence threshold.
 */
export function createPropositionCandidateSearch(nodes: readonly GraphNode[]) {
	const indexed = nodes.map((node) => ({
		node,
		texts: [
			indexText(`${node.name} ${node.statement}`),
			...[...new Set(node.aliases)]
				.filter((alias) => alias !== node.statement)
				.map((alias) => indexText(`${node.name} ${alias}`, alias)),
		],
	}));
	const frequency = new Map<string, number>();
	let totalLength = 0;
	let textCount = 0;
	for (const entry of indexed) {
		const nodeTerms = new Set<string>();
		for (const text of entry.texts) {
			totalLength += text.length;
			textCount++;
			for (const term of text.terms.keys()) nodeTerms.add(term);
		}
		for (const term of nodeTerms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
	}
	const averageLength = totalLength / textCount || 1;

	return (proposition: CandidateProposition, hints: readonly string[] = []) => {
		const query = new Set(
			tokenize([proposition.name, proposition.statement, ...proposition.aliases, ...(proposition.topics ?? []), ...hints].join(" ")),
		);
		const hits: Array<{ node: GraphNode; score: number; matchedAlias?: string }> = [];
		for (const { node, texts } of indexed) {
			let bestScore = 0;
			let matchedAlias: string | undefined;
			for (const text of texts) {
				let score = 0;
				for (const term of query) {
					const tf = text.terms.get(term) ?? 0;
					if (tf === 0) continue;
					const df = frequency.get(term)!;
					const idf = Math.log(1 + (indexed.length - df + 0.5) / (df + 0.5));
					score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * text.length) / averageLength));
				}
				if (score > bestScore) {
					bestScore = score;
					// An alias is evidence only when its own wording matched,
					// not just the repeated canonical name.
					matchedAlias = text.alias && tokenize(text.alias).some((term) => query.has(term)) ? text.alias : undefined;
				}
			}
			if (bestScore > 0) hits.push({ node, score: bestScore, matchedAlias });
		}
		return hits.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
	};
}

/** Reject bad ids/offsets before returning any part of a batch. Every call is
 * stateless: repeating a request returns the same page, never a hidden miss. */
export function propositionCandidateBatch(
	search: ReturnType<typeof createPropositionCandidateSearch>,
	propositions: readonly CandidateProposition[],
	requests: readonly CandidateRequest[],
): CandidateBatch {
	// Match mergeFindings: repeated ids refer to their FIRST finding.
	const byId = new Map<string, CandidateProposition>();
	for (const proposition of propositions) {
		if (!byId.has(proposition.id)) byId.set(proposition.id, proposition);
	}
	const seen = new Set<string>();
	for (const request of requests) {
		if (!byId.has(request.id)) throw new Error(`Unknown proposition id "${request.id}". Use an id from the proposed findings.`);
		if (seen.has(request.id)) throw new Error(`Repeated proposition id "${request.id}". Combine its hints in one request.`);
		if (!Number.isSafeInteger(request.offset ?? 0) || (request.offset ?? 0) < 0) throw new Error("offset must be a nonnegative safe integer.");
		seen.add(request.id);
	}
	const candidates = new Map<string, CandidateBatch["candidates"][number]>();
	const matches = requests.map((request) => {
		const hits = search(byId.get(request.id)!, request.hints);
		const offset = request.offset ?? 0;
		const page = hits.slice(offset, offset + CANDIDATE_PAGE_SIZE);
		for (const { node, matchedAlias } of page) {
			let candidate = candidates.get(node.id);
			if (!candidate) {
				candidate = {
					id: node.id,
					name: node.name,
					statement: node.statement,
					matchedAliases: [],
					sessions: [...new Set(node.provenance.map((point) => point.chatId))],
				};
				candidates.set(node.id, candidate);
			}
			if (matchedAlias && !candidate.matchedAliases.includes(matchedAlias)) candidate.matchedAliases.push(matchedAlias);
		}
		const hasMore = offset + page.length < hits.length;
		return {
			propositionId: request.id,
			candidateIds: page.map((hit) => hit.node.id),
			offset,
			totalCandidates: hits.length,
			hasMore,
			nextOffset: hasMore ? offset + page.length : null,
		};
	});
	return { matches, candidates: [...candidates.values()] };
}
