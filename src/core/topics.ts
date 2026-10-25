/**
 * Topic identity and membership (PR H) - pure.
 *
 * A topic's identity is its NORMALISED LABEL (documents.ts topicKey: NFKC,
 * whitespace-collapsed, case-folded); the display casing is the first one
 * seen. Variant spellings ("Semaphor", "Semaphoren", "semaphores") become
 * one topic through the ALIAS TABLE: variant key -> canonical display label,
 * written by the document service before extraction (a cheap-slot agent
 * proposes the mapping) and applied here, deterministically, by the merger.
 *
 * Membership lives in the append-only topics ledger (TopicRow); a node's
 * home topic in "Group by topic" is the FIRST row it received.
 *
 * Node-bound only through documents.ts (sha256), like graph.ts: the server
 * imports it directly, it stays out of the browser barrel.
 */

import type { TopicRow } from "./contracts/graph.ts";
import { normalizeTopics, topicKey } from "./documents.ts";

/** How many topics one proposition may carry (the extractor is told; the
 *  submit seam refuses more). */
export const MAX_TOPICS_PER_PROPOSITION = 3;

/** The canonical display label of a raw topic under the alias table. */
export function canonicalTopic(raw: string, aliases: Readonly<Record<string, string>>): string {
	const display = raw.replace(/\s+/g, " ").trim();
	const target = aliases[topicKey(display)];
	return target !== undefined && target.trim() !== "" ? target.replace(/\s+/g, " ").trim() : display;
}

/** Canonicalise a topic list: aliases applied, then deduped by key. */
export function canonicalTopics(raw: readonly string[], aliases: Readonly<Record<string, string>>): string[] {
	return normalizeTopics(raw.map((t) => canonicalTopic(t, aliases)));
}

/** Fold a proposed mapping (raw topic -> canonical label) into the alias
 *  table. Only genuine renames are stored (a topic mapped to itself needs no
 *  row), and a canonical label is never itself aliased onward: the table
 *  stays one hop deep, so applying it is a single lookup. */
export function addAliases(
	table: Readonly<Record<string, string>>,
	mapping: Readonly<Record<string, string>>,
): Record<string, string> {
	const next: Record<string, string> = { ...table };
	for (const [raw, canonical] of Object.entries(mapping)) {
		const from = topicKey(raw);
		const to = canonicalTopic(canonical, next); // follow an existing alias once
		if (from === "" || topicKey(to) === "" || from === topicKey(to)) continue;
		next[from] = to;
	}
	return next;
}

/** nodeId -> its canonical topics in ledger order, deduped by key. */
export function topicsByNode(rows: readonly TopicRow[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const row of rows) {
		const list = out.get(row.nodeId) ?? [];
		if (!list.some((t) => topicKey(t) === topicKey(row.topic))) list.push(row.topic);
		out.set(row.nodeId, list);
	}
	return out;
}

/** Every distinct canonical topic known to the ledger, first display wins. */
export function knownTopics(rows: readonly TopicRow[]): string[] {
	return normalizeTopics(rows.map((r) => r.topic));
}
