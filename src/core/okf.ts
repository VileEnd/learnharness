/**
 * THE OKF v0.2 RENDERER (pure): graph + documents (+ later the learner
 * model) -> a list of {path, content} files that form an Open Knowledge
 * Format bundle (https://github.com/GoogleCloudPlatform/open-knowledge-format,
 * SPEC.md v0.2). Deterministic: the same input always yields the same files
 * in the same (sorted) order. The bundle is a REGENERABLE CACHE of the
 * ledgers - never a source of truth; the OkfBundleStore adapter is its sole
 * writer.
 *
 * Layout (docs/superpowers/specs/2026-10-25-okf-library-and-learner-model-design.md, Part 1):
 *   index.md, log.md
 *   topics/index.md, topics/<topic>.md
 *   documents/index.md, documents/<doc>.md, documents/<doc>/index.md,
 *     documents/<doc>/<sid>-<slug>.md
 *   concepts/index.md, concepts/<concept>.md
 *
 * Gates (the agent settings) remove gated content EVERYWHERE, cross-links
 * and counts included: documents:false -> no documents/ and no link to it;
 * graph:false -> no concepts/, no me/, no concept name or count anywhere.
 *
 * Index files follow the Google reference generator (bundle/index.py): one
 * "# <Type>" section per type, sorted, entries "* [Title](link) - description",
 * directories under "# Subdirectories". No frontmatter in any index.md except
 * the root's okf_version.
 */

import { createHash } from "node:crypto";
import type { DocumentMeta, DocumentSection } from "./contracts/documents.ts";
import type { GraphChain, GraphNode } from "./contracts/graph.ts";
import type { OkfFile, OkfInput } from "./contracts/okf.ts";
import { topicKey } from "./topic-key.ts";

export const OKF_VERSION = "0.2";
/** Bumped when the renderer changes what it writes; part of the freshness stamp, so a deploy rebuilds the bundle. */
export const OKF_RENDER_REV = 1;
/** log.md keeps at most this many date headings (newest first); older days drop off. */
export const LOG_MAX_DATES = 100;
/** Index lines carry a description cut to this many characters. */
const INDEX_DESC_MAX = 140;
const SLUG_MAX = 60;

// ─── frontmatter ─────────────────────────────────────────────────────────────

export type OkfValue = string | number | string[] | Record<string, string> | Array<Record<string, string>>;

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const q = (s: string) => JSON.stringify(s);

function flowMap(m: Record<string, string>): string {
	const parts = Object.entries(m).map(([k, v]) => {
		if (!KEY.test(k)) throw new Error(`invalid frontmatter key ${k}`);
		return `${k}: ${q(v)}`;
	});
	return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/**
 * A deterministic YAML subset: strings are JSON-quoted (valid YAML double-
 * quoted scalars), string lists and mappings are flow style, lists of
 * mappings are block style. Keys keep insertion order. Returns the whole
 * block including both `---` fences and the trailing newline.
 */
export function okfFrontmatter(fields: Record<string, OkfValue>): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(fields)) {
		if (!KEY.test(key)) throw new Error(`invalid frontmatter key ${key}`);
		if (typeof value === "string") lines.push(`${key}: ${q(value)}`);
		else if (typeof value === "number") lines.push(`${key}: ${String(value)}`);
		else if (Array.isArray(value)) {
			if (value.length === 0) lines.push(`${key}: []`);
			else if (typeof value[0] === "string") lines.push(`${key}: [${(value as string[]).map(q).join(", ")}]`);
			else {
				lines.push(`${key}:`);
				for (const item of value as Array<Record<string, string>>) {
					const entries = Object.entries(item);
					entries.forEach(([k, v], i) => {
						if (!KEY.test(k)) throw new Error(`invalid frontmatter key ${k}`);
						lines.push(`${i === 0 ? "  - " : "    "}${k}: ${q(v)}`);
					});
				}
			}
		} else lines.push(`${key}: ${flowMap(value)}`);
	}
	lines.push("---");
	return `${lines.join("\n")}\n`;
}

// ─── slugs and paths ─────────────────────────────────────────────────────────

/** Kebab-case ASCII without a suffix (shared by section file names). */
function slugBase(text: string): string {
	let t = text
		.toLowerCase()
		.replace(/ä/g, "ae")
		.replace(/ö/g, "oe")
		.replace(/ü/g, "ue")
		.replace(/ß/g, "ss")
		.replace(/\+/g, " plus ")
		.replace(/#/g, " sharp ");
	t = t.normalize("NFD").replace(/\p{M}/gu, "");
	t = t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (t.length > SLUG_MAX) t = t.slice(0, SLUG_MAX).replace(/-+$/, "");
	return t === "" ? "item" : t;
}

const cleanSuffix = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "") || "x";

/**
 * Kebab-case ASCII: ä->ae ö->oe ü->ue ß->ss, "+" -> plus, "#" -> sharp,
 * everything else non-alphanumeric -> "-", collapsed, capped at 60 chars,
 * then "-<suffix>" (the short id/hash that keeps distinct titles distinct).
 */
export function okfSlug(text: string, suffix: string): string {
	return `${slugBase(text)}-${cleanSuffix(suffix)}`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function conceptPath(node: GraphNode, title?: string): string {
	return `concepts/${okfSlug(title ?? node.name, node.id.slice(2, 8))}.md`;
}

export function documentPath(meta: DocumentMeta): string {
	return `documents/${okfSlug(meta.title, meta.id.slice(4, 10))}.md`;
}

export function topicPath(label: string): string {
	return `topics/${okfSlug(label, sha256(label).slice(0, 4))}.md`;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The relative POSIX link from one bundle file to another. */
function rel(from: string, to: string): string {
	const a = dirOf(from).split("/").filter(Boolean);
	const b = to.split("/");
	let i = 0;
	while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
	return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

// ─── text helpers ────────────────────────────────────────────────────────────

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** Link text: one line, brackets escaped so the link stays well-formed. */
const mdText = (s: string) => oneLine(s).replace(/([[\]])/g, "\\$1");
const cut = (s: string, max: number) => {
	const t = oneLine(s);
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
const lc = (s: string) => s.toLowerCase();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const link = (from: string, to: string, title: string) => `[${mdText(title)}](${rel(from, to)})`;

function pagesText(from?: number, to?: number): string {
	if (from === undefined) return "";
	return to === undefined || to === from ? `p. ${from}` : `pp. ${from}-${to}`;
}

interface IndexEntry {
	type: string;
	title: string;
	link: string;
	desc: string;
}

/** The reference generator's index body (bundle/index.py _build_index_text). */
function indexText(entries: IndexEntry[]): string {
	const grouped = new Map<string, IndexEntry[]>();
	for (const e of entries) {
		const t = e.type || "Other";
		const bucket = grouped.get(t);
		if (bucket) bucket.push(e);
		else grouped.set(t, [e]);
	}
	const sections: string[] = [];
	for (const type of [...grouped.keys()].sort(cmp)) {
		const lines = [`# ${type}`, ""];
		const sorted = [...grouped.get(type)!].sort((a, b) => cmp(lc(a.title), lc(b.title)) || cmp(a.link, b.link));
		for (const e of sorted) {
			const d = cut(e.desc, INDEX_DESC_MAX);
			lines.push(`* [${mdText(e.title)}](${e.link})${d ? ` - ${d}` : ""}`);
		}
		sections.push(lines.join("\n"));
	}
	return `${sections.join("\n\n")}\n`;
}

// ─── the renderer ────────────────────────────────────────────────────────────

interface SectionInfo {
	sec: DocumentSection;
	path: string;
	heading: string;
}
interface DocInfo {
	meta: DocumentMeta;
	text: string;
	path: string;
	dir: string;
	key: string;
	sections: SectionInfo[];
}
interface SourceEntry {
	id: string;
	resource: string;
	title: string;
}

const headingOf = (sec: DocumentSection) => sec.headingPath.at(-1) ?? "";
const sectionTitle = (sec: DocumentSection) => headingOf(sec) || "Introduction";
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-");
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}/.test(s);

export function renderOkfBundle(input: OkfInput): OkfFile[] {
	const { gates } = input;
	const files = new Map<string, string>();
	const put = (path: string, content: string) => void files.set(path, content);

	// ── documents ──
	const docs: DocInfo[] = [];
	const usedDocPaths = new Set<string>();
	for (const d of [...input.documents].sort((a, b) => cmp(a.meta.id, b.meta.id))) {
		let path = documentPath(d.meta);
		if (usedDocPaths.has(path)) path = `documents/${okfSlug(d.meta.title, d.meta.id.slice(4))}.md`;
		usedDocPaths.add(path);
		const dir = path.slice(0, -3);
		const secs = d.meta.sections.length > 0 ? d.meta.sections : [{ id: "s1", headingPath: [], start: 0, end: d.text.length }];
		docs.push({
			meta: d.meta,
			text: d.text,
			path,
			dir,
			key: cleanSuffix(d.meta.id.slice(4, 10)),
			sections: secs.map((sec) => ({
				sec,
				path: `${dir}/${cleanSuffix(sec.id)}-${slugBase(headingOf(sec) || "intro")}.md`,
				heading: sectionTitle(sec),
			})),
		});
	}
	const docBySource = new Map(docs.map((d) => [d.meta.sourceId, d]));
	const chatById = new Map(input.chats.map((c) => [c.id, c]));
	/** A provenance source "exists" when it is a chat or a stored document (gates aside).
	 *  "src_" ids are imported-notes sources from before the document library: the graph's own
	 *  record of that import, which only a graph deletion removes (and that purges the
	 *  provenance too), so they count as existing - otherwise every old import would read as deprecated. */
	const sourceExists = (id: string) => chatById.has(id) || docBySource.has(id) || id.startsWith("src_");

	// ── nodes, chains ──
	const nodes: GraphNode[] = [];
	const nodeIds = new Set<string>();
	if (gates.graph) {
		for (const n of [...input.nodes].sort((a, b) => cmp(a.id, b.id))) {
			if (nodeIds.has(n.id)) continue;
			nodeIds.add(n.id);
			nodes.push(n);
		}
	}
	const nodePath = new Map<string, string>();
	const usedNodePaths = new Set<string>();
	for (const n of nodes) {
		let path = conceptPath(n);
		if (usedNodePaths.has(path)) path = `concepts/${okfSlug(n.name, n.id.slice(2))}.md`;
		usedNodePaths.add(path);
		nodePath.set(n.id, path);
	}
	const nodeById = new Map(nodes.map((n) => [n.id, n]));

	// Valid chains only: every endpoint exists, no self reference. A chain with a
	// missing endpoint is dropped WHOLE (never a false conjunction).
	const chains: GraphChain[] = [];
	const seenChains = new Set<string>();
	if (gates.graph) {
		for (const c of input.chains) {
			if (c.premises.length === 0 || !nodeIds.has(c.conclusion) || c.premises.some((p) => !nodeIds.has(p) || p === c.conclusion)) continue;
			const key = `${[...c.premises].sort().join("|")}=>${c.conclusion}`;
			if (seenChains.has(key)) continue;
			seenChains.add(key);
			chains.push(c);
		}
	}

	// ── topics ──
	const canon = (label: string) => oneLine(input.aliases[topicKey(label)] ?? label);
	interface TopicAcc {
		labels: Set<string>;
		nodes: Set<string>;
		docs: Set<string>;
	}
	const topicAcc = new Map<string, TopicAcc>();
	const accFor = (label: string): TopicAcc | null => {
		const l = canon(label);
		if (l === "") return null;
		const k = topicKey(l);
		let a = topicAcc.get(k);
		if (!a) topicAcc.set(k, (a = { labels: new Set(), nodes: new Set(), docs: new Set() }));
		a.labels.add(l);
		return a;
	};
	const nodeTopicKeys = new Map<string, string[]>(); // ledger order, de-duplicated
	if (gates.graph) {
		for (const row of input.topics) {
			if (!nodeIds.has(row.nodeId)) continue;
			const a = accFor(row.topic);
			if (!a) continue;
			a.nodes.add(row.nodeId);
			const k = topicKey(canon(row.topic));
			const list = nodeTopicKeys.get(row.nodeId) ?? [];
			if (!list.includes(k)) list.push(k);
			nodeTopicKeys.set(row.nodeId, list);
		}
	}
	if (gates.documents) {
		for (const d of docs) {
			for (const t of d.meta.topics) accFor(t)?.docs.add(d.meta.id);
		}
		for (const row of input.topics) {
			const d = docBySource.get(row.sourceId);
			if (d) accFor(row.topic)?.docs.add(d.meta.id);
		}
	}
	interface Topic {
		key: string;
		label: string;
		path: string;
		nodes: string[];
		docs: string[];
	}
	const topics: Topic[] = [];
	const topicByKey = new Map<string, Topic>();
	const usedTopicPaths = new Set<string>();
	for (const [key, a] of [...topicAcc.entries()].sort((x, y) => cmp(x[0], y[0]))) {
		if (a.nodes.size === 0 && a.docs.size === 0) continue;
		const label = [...a.labels].sort(cmp)[0]!;
		let path = topicPath(label);
		if (usedTopicPaths.has(path)) path = `topics/${okfSlug(label, sha256(label).slice(0, 12))}.md`;
		usedTopicPaths.add(path);
		const t: Topic = { key, label, path, nodes: [...a.nodes].sort(cmp), docs: [...a.docs].sort(cmp) };
		topics.push(t);
		topicByKey.set(key, t);
	}
	const labelsOf = (nodeId: string) =>
		(nodeTopicKeys.get(nodeId) ?? []).map((k) => topicByKey.get(k)?.label).filter((l): l is string => l !== undefined);
	const untagged = nodes.filter((n) => labelsOf(n.id).length === 0);

	// ── concept sources ──
	const sectionConcepts = new Map<string, GraphNode[]>(); // section file path -> concepts
	const sourcesOf = (n: GraphNode, from: string): { entries: SourceEntry[]; docRefs: string[]; chatIds: string[] } => {
		const entries: SourceEntry[] = [];
		const seen = new Set<string>();
		const docRefs: string[] = []; // section or document paths, in provenance order
		if (gates.documents) {
			const add = (d: DocInfo, s?: SectionInfo, pageFrom?: number, pageTo?: number) => {
				const key = s ? `${d.key}-${cleanSuffix(s.sec.id)}` : d.key;
				if (seen.has(key)) return;
				seen.add(key);
				const target = s ? s.path : d.path;
				const pages = pagesText(pageFrom ?? s?.sec.pageFrom, pageTo ?? s?.sec.pageTo);
				const title = [d.meta.title, s ? s.heading : "", pages].filter(Boolean).join(" · ");
				entries.push({ id: key, resource: rel(from, target), title });
				docRefs.push(target);
			};
			for (const p of n.provenance) {
				const d = docBySource.get(p.chatId);
				if (!d) continue;
				const s = p.section ? d.sections.find((x) => x.sec.id === p.section) : undefined;
				add(d, s, p.pageFrom, p.pageTo);
			}
			for (const row of input.topics) {
				if (row.nodeId !== n.id) continue;
				const d = docBySource.get(row.sourceId);
				if (d && !entries.some((e) => e.id === d.key || e.id.startsWith(`${d.key}-`))) add(d);
			}
		}
		const chatIds: string[] = [];
		const chatEntries: SourceEntry[] = [];
		for (const p of n.provenance) {
			const c = chatById.get(p.chatId);
			if (!c || chatIds.includes(c.id)) continue;
			chatIds.push(c.id);
			chatEntries.push({
				id: safeId(c.id),
				resource: `learnharness:chat/${c.id}`,
				title: `Teaching session "${oneLine(c.title)}"${isDate(c.createdAt) ? `, ${c.createdAt.slice(0, 10)}` : ""}`,
			});
		}
		entries.sort((a, b) => cmp(a.resource, b.resource));
		chatEntries.sort((a, b) => {
			const ca = chatById.get(a.resource.slice("learnharness:chat/".length))!;
			const cb = chatById.get(b.resource.slice("learnharness:chat/".length))!;
			return cmp(ca.createdAt, cb.createdAt) || cmp(ca.id, cb.id);
		});
		return { entries: [...entries, ...chatEntries], docRefs, chatIds };
	};

	// ── concept files ──
	const follows = new Map<string, string[][]>();
	const leads = new Map<string, Array<{ conclusion: string; others: string[] }>>();
	for (const c of chains) {
		const list = follows.get(c.conclusion) ?? [];
		list.push(c.premises);
		follows.set(c.conclusion, list);
		for (const p of c.premises) {
			const l = leads.get(p) ?? [];
			l.push({ conclusion: c.conclusion, others: c.premises.filter((x) => x !== p) });
			leads.set(p, l);
		}
	}
	const nodeLink = (from: string, id: string) => link(from, nodePath.get(id)!, nodeById.get(id)!.name);
	const nodeSourceGroup = new Map<string, { ref: string | null; chat: string | null }>();
	const conceptEntries: IndexEntry[] = [];
	for (const n of nodes) {
		const path = nodePath.get(n.id)!;
		const src = sourcesOf(n, path);
		for (const ref of src.docRefs) {
			if (!docs.some((d) => d.sections.some((s) => s.path === ref))) continue;
			const list = sectionConcepts.get(ref) ?? [];
			list.push(n);
			sectionConcepts.set(ref, list);
		}
		nodeSourceGroup.set(n.id, { ref: src.docRefs[0] ?? null, chat: src.chatIds[0] ?? null });
		const existing = new Set<string>();
		for (const p of n.provenance) if (sourceExists(p.chatId)) existing.add(p.chatId);
		const tags = labelsOf(n.id);
		const fm: Record<string, OkfValue> = {
			type: "Proposition",
			title: oneLine(n.name),
			description: oneLine(n.statement),
			tags,
			id: n.id,
			status: existing.size === 0 ? "deprecated" : "stable",
			generated: { by: "learnharness/extraction", at: n.createdAt },
		};
		if (existing.size > 1) fm.verified = Array.from({ length: existing.size - 1 }, () => ({ by: "learnharness/auditor" }));
		fm.sources = src.entries.map((e) => ({ id: e.id, resource: e.resource, title: e.title }));

		const body: string[] = [n.statement.trim()];
		const from = [...(follows.get(n.id) ?? [])]
			.map((ps) => ps.map((p) => nodeLink(path, p)).join(" + "))
			.filter((v, i, a) => a.indexOf(v) === i)
			.sort((a, b) => cmp(lc(a), lc(b)));
		if (from.length > 0) body.push(`## Follows from\n${from.map((l) => `- ${l}`).join("\n")}`);
		const to = [...(leads.get(n.id) ?? [])]
			.map((l) => {
				const base = nodeLink(path, l.conclusion);
				return l.others.length > 0 ? `${base} (together with ${l.others.map((o) => nodeLink(path, o)).join(" + ")})` : base;
			})
			.filter((v, i, a) => a.indexOf(v) === i)
			.sort((a, b) => cmp(lc(a), lc(b)));
		if (to.length > 0) body.push(`## Leads to\n${to.map((l) => `- ${l}`).join("\n")}`);
		const phrasings = n.aliases.map(oneLine).filter((a, i, all) => a !== "" && a !== oneLine(n.statement) && all.indexOf(a) === i);
		if (phrasings.length > 0) body.push(`## Also phrased as\n${phrasings.map((a) => `- ${a}`).join("\n")}`);
		put(path, `${okfFrontmatter(fm)}${body.join("\n\n")}\n`);
		conceptEntries.push({ type: tags.length > 0 ? "Proposition" : "Untagged", title: n.name, link: path.slice("concepts/".length), desc: n.statement });
	}

	// ── document files ──
	const docEntries: IndexEntry[] = [];
	if (gates.documents) {
		for (const d of docs) {
			const m = d.meta;
			const topicLabels = m.topics.map((t) => topicByKey.get(topicKey(canon(t)))?.label).filter((l): l is string => l !== undefined);
			const fm: Record<string, OkfValue> = {
				type: "Document",
				title: oneLine(m.title),
				description: oneLine(m.summary),
				tags: topicLabels.filter((l, i, a) => a.indexOf(l) === i),
				id: m.id,
				aliases: m.filenames,
				imported: m.importedAt,
			};
			if (m.pages !== undefined) fm.pages = m.pages;
			const outline = d.sections.map((s) => {
				const pg = pagesText(s.sec.pageFrom, s.sec.pageTo);
				return `- ${link(d.path, s.path, s.heading)}${pg ? ` (${pg})` : ""}`;
			});
			put(d.path, `${okfFrontmatter(fm)}${m.summary.trim() === "" ? "" : `${m.summary.trim()}\n\n`}## Outline\n${outline.join("\n")}\n`);

			const secEntries: IndexEntry[] = [];
			for (const s of d.sections) {
				const pg = pagesText(s.sec.pageFrom, s.sec.pageTo);
				const sfm: Record<string, OkfValue> = {
					type: "Section",
					title: s.heading,
					description: `${m.title}${pg ? `, ${pg}` : ""}`,
					id: `${m.id}#${s.sec.id}`,
					sources: [{ id: d.key, resource: rel(s.path, d.path), title: m.title }],
				};
				const parts = [d.text.slice(s.sec.start, s.sec.end).trimEnd()];
				const cs = (sectionConcepts.get(s.path) ?? []).slice().sort((a, b) => cmp(lc(a.name), lc(b.name)) || cmp(a.id, b.id));
				let tail = "";
				if (cs.length > 0) tail = `## Concepts from this section\n${cs.map((c) => `- ${nodeLink(s.path, c.id)}`).join("\n")}`;
				put(s.path, `${okfFrontmatter(sfm)}${parts[0]!}\n${tail ? `\n${tail}\n` : ""}`);
				secEntries.push({ type: "Section", title: s.heading, link: s.path.slice(d.dir.length + 1), desc: pg });
			}
			put(`${d.dir}/index.md`, indexText(secEntries));
			docEntries.push({ type: "Document", title: m.title, link: d.path.slice("documents/".length), desc: m.summary });
			docEntries.push({ type: "Subdirectories", title: d.dir.slice("documents/".length), link: `${d.dir.slice("documents/".length)}/index.md`, desc: m.summary });
		}
		if (docs.length > 0) put("documents/index.md", indexText(docEntries));
	}

	// ── topic files ──
	const topicEntries: IndexEntry[] = [];
	for (const t of topics) {
		const tDocs = docs.filter((d) => gates.documents && t.docs.includes(d.meta.id));
		const tNodes = t.nodes.map((id) => nodeById.get(id)!).filter(Boolean);
		const descParts: string[] = [];
		if (tDocs.length > 0) descParts.push(`${tDocs.length} ${tDocs.length === 1 ? "document" : "documents"}`);
		if (tNodes.length > 0) descParts.push(`${tNodes.length} ${tNodes.length === 1 ? "concept" : "concepts"}`);
		const desc = descParts.join(", ");
		const body: string[] = [];
		if (tDocs.length > 0) {
			const lines: string[] = [];
			for (const d of tDocs) {
				lines.push(`- ${link(t.path, d.path, d.meta.title)}${d.meta.summary ? ` - ${cut(d.meta.summary, INDEX_DESC_MAX)}` : ""}`);
				for (const s of d.sections) lines.push(`  - ${link(t.path, s.path, s.heading)}`);
			}
			body.push(`## Documents\n${lines.join("\n")}`);
		}
		if (tNodes.length > 0) {
			const groups = new Map<string, { label: string; items: GraphNode[] }>();
			for (const n of tNodes) {
				const g = nodeSourceGroup.get(n.id);
				let key: string;
				let label: string;
				const sec = g?.ref ? docs.flatMap((d) => d.sections.map((s) => ({ d, s }))).find((x) => x.s.path === g.ref) : undefined;
				if (sec) {
					key = `a:${sec.s.path}`;
					label = `${link(t.path, sec.s.path, `${sec.d.meta.title} · ${sec.s.heading}`)}`;
				} else if (g?.chat && chatById.has(g.chat)) {
					const c = chatById.get(g.chat)!;
					key = `b:${c.id}`;
					label = `Session "${mdText(c.title)}"${isDate(c.createdAt) ? ` (${c.createdAt.slice(0, 10)})` : ""}`;
				} else if (g?.ref) {
					const d = docs.find((x) => x.path === g.ref)!;
					key = `a:${d.path}`;
					label = link(t.path, d.path, d.meta.title);
				} else {
					key = "z:other";
					label = "Other";
				}
				const grp = groups.get(key);
				if (grp) grp.items.push(n);
				else groups.set(key, { label, items: [n] });
			}
			const parts: string[] = ["## Concepts"];
			for (const key of [...groups.keys()].sort(cmp)) {
				const g = groups.get(key)!;
				parts.push(`### ${g.label}`);
				for (const n of g.items.sort((a, b) => cmp(lc(a.name), lc(b.name)) || cmp(a.id, b.id))) {
					parts.push(`- ${nodeLink(t.path, n.id)} - ${cut(n.statement, INDEX_DESC_MAX)}`);
				}
			}
			// Group headings sit between bullet runs; keep a blank line before each heading.
			body.push(parts.reduce((acc, line, i) => (i === 0 ? line : line.startsWith("###") ? `${acc}\n\n${line}` : `${acc}\n${line}`), ""));
		}
		const fm: Record<string, OkfValue> = { type: "Topic", title: t.label, description: desc, id: t.key };
		put(t.path, `${okfFrontmatter(fm)}${body.join("\n\n")}\n`);
		topicEntries.push({ type: "Topic", title: t.label, link: t.path.slice("topics/".length), desc });
	}
	if (untagged.length > 0) {
		topicEntries.push({ type: "Untagged", title: "Concepts without a topic", link: "../concepts/index.md", desc: `${untagged.length} ${untagged.length === 1 ? "concept" : "concepts"}` });
	}
	if (topicEntries.length > 0) put("topics/index.md", indexText(topicEntries));
	if (nodes.length > 0) put("concepts/index.md", indexText(conceptEntries));

	// ── log.md ──
	const byDate = new Map<string, string[]>();
	const logLine = (date: string | undefined, line: string) => {
		if (!isDate(date)) return;
		const k = date.slice(0, 10);
		const l = byDate.get(k) ?? [];
		l.push(line);
		byDate.set(k, l);
	};
	if (gates.documents) {
		for (const d of docs) {
			logLine(d.meta.importedAt, `* **Creation**: Imported ${link("log.md", d.path, d.meta.title)}.`);
			if (isDate(d.meta.updatedAt) && d.meta.updatedAt.slice(0, 10) !== d.meta.importedAt.slice(0, 10)) {
				logLine(d.meta.updatedAt, `* **Update**: Updated ${link("log.md", d.path, d.meta.title)}.`);
			}
		}
	}
	const created = new Map<string, number>();
	for (const n of nodes) if (isDate(n.createdAt)) created.set(n.createdAt.slice(0, 10), (created.get(n.createdAt.slice(0, 10)) ?? 0) + 1);
	for (const [date, count] of created) logLine(date, `* **Creation**: Extracted ${count} ${count === 1 ? "concept" : "concepts"}.`);
	if (isDate(input.now)) logLine(input.now, "* **Update**: Regenerated the library from the current data.");
	const logSections = [...byDate.keys()]
		.sort((a, b) => cmp(b, a))
		.slice(0, LOG_MAX_DATES)
		.map((date) => `## ${date}\n${[...byDate.get(date)!].sort(cmp).join("\n")}`);
	put("log.md", `# Library Update Log\n${logSections.length > 0 ? `\n${logSections.join("\n\n")}\n` : ""}`);

	// ── root index.md ──
	const subdirs: IndexEntry[] = [];
	if (nodes.length > 0) subdirs.push({ type: "Subdirectories", title: "concepts", link: "concepts/index.md", desc: `${nodes.length} propositions with the reasoning chains between them` });
	if (docs.length > 0 && gates.documents) subdirs.push({ type: "Subdirectories", title: "documents", link: "documents/index.md", desc: `${docs.length} imported ${docs.length === 1 ? "document" : "documents"}, split into sections` });
	if (topicEntries.length > 0) subdirs.push({ type: "Subdirectories", title: "topics", link: "topics/index.md", desc: "the subjects, with their documents and concepts" });
	const nav: string[] = ["# How to navigate", ""];
	nav.push(topicEntries.length > 0 ? "* Start with topics/index.md, open a topic, then follow its links." : "* Start with the directories listed above.");
	if (docs.length > 0 && gates.documents) nav.push("* A document's sections hold the full text with page markers; cite them as title, page.");
	if (nodes.length > 0) nav.push("* A concept states one proposition and links the concepts it follows from and leads to.");
	nav.push("* log.md lists what changed, newest first.");
	put("index.md", `${okfFrontmatter({ okf_version: OKF_VERSION })}${subdirs.length > 0 ? `${indexText(subdirs)}\n` : ""}${nav.join("\n")}\n`);

	return [...files.entries()].sort((a, b) => cmp(a[0], b[0])).map(([path, content]) => ({ path, content }));
}

// ─── conformance ─────────────────────────────────────────────────────────────

const LINK_RE = /\[(?:\\.|[^\]\\])*\]\(([^)\s]+)\)/g;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function splitFrontmatter(content: string): { fm: string | null; body: string } {
	if (!content.startsWith("---\n")) return { fm: null, body: content };
	const end = content.indexOf("\n---\n", 3);
	if (end === -1) {
		if (content.endsWith("\n---")) return { fm: content.slice(4, -4), body: "" };
		return { fm: null, body: content };
	}
	return { fm: content.slice(4, end), body: content.slice(end + 5) };
}

function resolveRel(fromPath: string, target: string): string | null {
	const parts = dirOf(fromPath).split("/").filter(Boolean);
	for (const seg of target.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(seg);
	}
	return parts.join("/");
}

/**
 * Problems that make a bundle non-conformant with OKF v0.2 as the design
 * defines it (empty = conformant): a `type` on every non-reserved file; no
 * frontmatter in index.md except the root's okf_version; ISO date headings
 * in log.md; every relative link and bundle-relative `sources[].resource`
 * resolving inside the bundle (URLs and learnharness: URIs are external).
 * Imported document text is the learner's own and may link anywhere, so a
 * Section file is checked for links only in its trailing generated block.
 */
export function checkOkfConformance(files: OkfFile[]): string[] {
	const problems: string[] = [];
	const known = new Set(files.map((f) => f.path));
	const checkLink = (from: string, target: string, what: string) => {
		const t = target.split("#")[0]!.split("?")[0]!;
		if (t === "" || SCHEME.test(t)) return;
		const abs = t.startsWith("/") ? resolveRel("", t.slice(1)) : resolveRel(from, t);
		if (abs === null || !known.has(abs)) problems.push(`${from}: ${what} ${target} does not resolve`);
	};
	for (const f of files) {
		const name = f.path.split("/").pop()!;
		const { fm, body } = splitFrontmatter(f.content);
		if (name === "index.md") {
			if (fm !== null) {
				const keys = fm.split("\n").filter((l) => /^\S/.test(l)).map((l) => l.split(":")[0]);
				if (f.path !== "index.md") problems.push(`${f.path}: index.md must not have frontmatter`);
				else if (keys.length !== 1 || keys[0] !== "okf_version") problems.push(`${f.path}: root index.md may only carry okf_version`);
			}
		} else if (name === "log.md") {
			for (const line of body.split("\n")) {
				if (line.startsWith("## ") && !/^## \d{4}-\d{2}-\d{2}$/.test(line)) problems.push(`${f.path}: log heading "${line}" is not an ISO date`);
			}
		} else if (name.endsWith(".md")) {
			if (fm === null) {
				problems.push(`${f.path}: missing frontmatter`);
				continue;
			}
			const typeLine = fm.split("\n").find((l) => l.startsWith("type:"));
			const typeValue = typeLine?.slice(5).trim().replace(/^"(.*)"$/, "$1") ?? "";
			if (typeValue === "") problems.push(`${f.path}: missing type`);
			for (const m of fm.matchAll(/^\s+resource: (".*")\s*$/gm)) {
				try {
					checkLink(f.path, JSON.parse(m[1]!) as string, "source");
				} catch {
					problems.push(`${f.path}: unparseable source resource`);
				}
			}
		}
		if (!name.endsWith(".md")) continue;
		let linkText = body;
		if (/^type: "Section"$/m.test(fm ?? "")) {
			const at = body.lastIndexOf("\n## Concepts from this section\n");
			linkText = at === -1 ? "" : body.slice(at);
		}
		for (const m of linkText.matchAll(LINK_RE)) checkLink(f.path, m[1]!, "link");
	}
	return problems;
}
