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

// ── canonicalise-and-store, under ONE alias lock ──
//
// The alias table is a single file replaced whole. Document imports and
// session extractions (different sources run in parallel) both extend it, so
// every read-modify-write goes through this async mutex: the (slow) model
// call runs OUTSIDE it, the table is re-read INSIDE it, so two concurrent
// canonicalisations always keep both aliases.

interface AliasLock {
	tail: Promise<void>;
}
const LOCK_KEY = "__lhTopicAliasLock";
function aliasLock(): AliasLock {
	const g = globalThis as { [LOCK_KEY]?: AliasLock };
	return (g[LOCK_KEY] ??= { tail: Promise.resolve() });
}

/** Run `fn` exclusively with respect to every other alias read-modify-write. */
export async function withTopicAliasLock<T>(fn: () => T | Promise<T>): Promise<T> {
	const lock = aliasLock();
	const prev = lock.tail;
	let release!: () => void;
	lock.tail = new Promise<void>((resolve) => (release = resolve));
	await prev;
	try {
		return await fn();
	} finally {
		release();
	}
}

export interface AliasPorts {
	readTopics(): TopicRow[];
	readTopicAliases(): Record<string, string>;
	writeTopicAliases(aliases: Record<string, string>): void;
}

/** Map proposed topics onto the library's existing ones (the optional
 *  `canonicalize` is the cheap-slot topicist), persist the mapping in the alias
 *  table under the lock, and return the canonical topics. Best effort: with no
 *  model or on any failure the topics are only folded through the aliases that
 *  already exist. `alsoExisting` adds labels the ledger does not hold yet. */
export async function canonicalizeAndStoreTopics(
	ports: AliasPorts,
	topics: readonly string[],
	canonicalize?: (newTopics: readonly string[], existing: readonly string[], signal?: AbortSignal) => Promise<Record<string, string>>,
	alsoExisting: readonly string[] = [],
	signal?: AbortSignal,
): Promise<string[]> {
	if (topics.length === 0) return [];
	try {
		const existing = normalizeTopics([...alsoExisting, ...knownTopics(ports.readTopics())]);
		const mapping = canonicalize ? await canonicalize(topics, existing, signal) : {};
		return await withTopicAliasLock(() => {
			const before = ports.readTopicAliases();
			const after = addAliases(before, mapping);
			if (JSON.stringify(after) !== JSON.stringify(before)) ports.writeTopicAliases(after);
			return canonicalTopics(topics, after);
		});
	} catch (err) {
		console.info(`[topics] canonicalisation skipped: ${err instanceof Error ? err.message : err}`);
		return canonicalTopics(topics, ports.readTopicAliases());
	}
}
