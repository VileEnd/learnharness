/**
 * The OKF graph viewer for the export (pure): a TypeScript port of the
 * reference implementation's viewer/generator.py
 * (https://github.com/GoogleCloudPlatform/open-knowledge-format, Apache-2.0,
 * Copyright 2026 Google LLC; see okf-viz/NOTICE). It builds the same graph
 * JSON (_build_graph) and injects it into the vendored template exactly as
 * upstream does, over our rendered `{path, content}` files instead of a
 * directory walk. The page loads cytoscape and marked from jsDelivr, so it
 * needs internet when opened.
 *
 * Deviations from upstream, on purpose: leading-"/" (bundle-relative) links
 * resolve inside the bundle (SPEC 6.1) instead of being skipped; the data is
 * embedded with "<" escaped so a "</script>" in a body cannot end the script
 * block; the template is filled with function replacers (no "$&" surprises);
 * reserved log.md is not a concept; "stale" is computed against `now`.
 */

import type { OkfFile } from "./contracts/okf.ts";
import { VIZ_CSS, VIZ_HTML, VIZ_JS } from "./okf-viz/assets.ts";

const PALETTE: Record<string, string> = {
	Proposition: "#3b82f6",
	Document: "#8b5cf6",
	Section: "#a78bfa",
	Topic: "#10b981",
	"Learner Topic": "#f59e0b",
	"Learner Concept": "#ef4444",
};
const DEFAULT_COLOR = "#94a3b8";
const LINK_RE = /\]\(([^)\s]+\.md)(?:#[A-Za-z0-9_-]*)?\)/g;

type Fm = Record<string, unknown>;

function scalar(raw: string): unknown {
	const v = raw.trim();
	if (v === "") return "";
	if (v.startsWith('"') || v.startsWith("[")) {
		try {
			return JSON.parse(v);
		} catch {
			return v;
		}
	}
	if (v.startsWith("{")) {
		const out: Record<string, string> = {};
		for (const m of v.matchAll(/([A-Za-z_][A-Za-z0-9_-]*): ("(?:[^"\\]|\\.)*")/g)) out[m[1]!] = JSON.parse(m[2]!) as string;
		return out;
	}
	return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

/** Reads back the frontmatter subset core/okf.ts writes (okfFrontmatter). */
function parseFrontmatter(fm: string): Fm {
	const out: Fm = {};
	const lines = fm.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]!);
		if (!m) continue;
		const key = m[1]!;
		if (m[2]! !== "") {
			out[key] = scalar(m[2]!);
			continue;
		}
		const items: Array<Record<string, unknown>> = [];
		while (i + 1 < lines.length && /^\s/.test(lines[i + 1]!)) {
			const item = /^(\s*- )?\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[++i]!);
			if (!item) continue;
			if (item[1] !== undefined || items.length === 0) items.push({});
			items[items.length - 1]![item[2]!] = scalar(item[3]!);
		}
		out[key] = items;
	}
	return out;
}

function split(content: string): { fm: Fm; body: string } {
	if (!content.startsWith("---\n")) return { fm: {}, body: content };
	const end = content.indexOf("\n---\n", 3);
	if (end === -1) return { fm: {}, body: content };
	return { fm: parseFrontmatter(content.slice(4, end)), body: content.slice(end + 5).replace(/^\n/, "") };
}

function resolveInside(fromPath: string, target: string): string | null {
	const parts = target.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
	for (const seg of target.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(seg);
	}
	return parts.join("/");
}

interface VizConcept {
	id: string;
	type: string;
	title: string;
	description: string;
	resource: string;
	tags: string[];
	body: string;
	status: string;
	generated: Record<string, unknown>;
	verified: Array<Record<string, unknown>>;
	staleAfter: string;
	sources: Array<Record<string, unknown>>;
	trustTier: string;
	stale: boolean;
	linksTo: string[];
}

const asRecords = (v: unknown): Array<Record<string, unknown>> => {
	if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
	return v && typeof v === "object" ? [v as Record<string, unknown>] : [];
};

function walkConcepts(files: OkfFile[], now: Date): VizConcept[] {
	const out: VizConcept[] = [];
	for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const name = f.path.split("/").pop()!;
		if (!f.path.endsWith(".md") || name === "index.md" || name === "log.md") continue;
		const { fm, body } = split(f.content);
		const id = f.path.slice(0, -3);
		const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? [String(fm.tags)] : [];
		const verified = asRecords(fm.verified);
		const staleAfter = typeof fm.stale_after === "string" ? fm.stale_after : "";
		const links: string[] = [];
		for (const m of body.matchAll(LINK_RE)) {
			const target = m[1]!;
			if (target.includes("://")) continue;
			const abs = resolveInside(f.path, target);
			if (abs === null || !abs.endsWith(".md")) continue;
			const noExt = abs.slice(0, -3);
			if (noExt !== "" && !links.includes(noExt)) links.push(noExt);
		}
		out.push({
			id,
			type: typeof fm.type === "string" && fm.type !== "" ? fm.type : "Unknown",
			title: typeof fm.title === "string" && fm.title !== "" ? fm.title : id,
			description: typeof fm.description === "string" ? fm.description : "",
			resource: typeof fm.resource === "string" ? fm.resource : "",
			tags,
			body,
			status: typeof fm.status === "string" && fm.status !== "" ? fm.status : "stable",
			generated: fm.generated && typeof fm.generated === "object" && !Array.isArray(fm.generated) ? (fm.generated as Record<string, unknown>) : {},
			verified,
			staleAfter,
			sources: asRecords(fm.sources),
			trustTier:
				verified.length === 0 ? "unverified" : verified.some((v) => String(v.by ?? "").startsWith("human:")) ? "human-reviewed" : "machine-confirmed",
			stale: staleAfter !== "" && !Number.isNaN(Date.parse(staleAfter)) && now.getTime() >= Date.parse(staleAfter),
			linksTo: links,
		});
	}
	return out;
}

/** The upstream `_build_graph` payload (cytoscape elements + bodies/types/palette). */
export function buildVizGraph(files: OkfFile[], now: Date = new Date()) {
	const concepts = walkConcepts(files, now);
	const ids = new Set(concepts.map((c) => c.id));
	const nodes = concepts.map((c) => ({
		data: {
			id: c.id,
			label: c.title || c.id,
			type: c.type,
			description: c.description,
			resource: c.resource,
			tags: c.tags,
			status: c.status,
			generated: c.generated,
			verified: c.verified,
			stale_after: c.staleAfter,
			sources: c.sources,
			trust_tier: c.trustTier,
			stale: c.stale,
			color: PALETTE[c.type] ?? DEFAULT_COLOR,
			size: 30 + Math.min(60, Math.floor(c.body.length / 200)),
		},
	}));
	const edges: Array<{ data: { id: string; source: string; target: string } }> = [];
	const seen = new Set<string>();
	for (const c of concepts) {
		for (const target of c.linksTo) {
			if (target === c.id || !ids.has(target)) continue;
			const key = `${c.id}\0${target}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ data: { id: `${c.id}__${target}`, source: c.id, target } });
		}
	}
	return {
		nodes,
		edges,
		bodies: Object.fromEntries(concepts.map((c) => [c.id, c.body])),
		types: [...new Set(concepts.map((c) => c.type))].sort(),
		palette: PALETTE,
	};
}

/** JSON safe inside an inline <script> (no "</script>", no raw line separators). */
const embedJson = (v: unknown) =>
	JSON.stringify(v).replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");

/** The single self-contained viz.html for a bundle's files. */
export function renderOkfViewer(files: OkfFile[], bundleName = "LearnHarness library", now: Date = new Date()): string {
	const graph = buildVizGraph(files, now);
	return VIZ_HTML.replace("/*__VIZ_CSS__*/", () => VIZ_CSS)
		.replace("/*__VIZ_JS__*/", () => VIZ_JS)
		.replace("__BUNDLE_NAME__", () => embedJson(bundleName))
		.replace("__BUNDLE_DATA__", () => embedJson(graph));
}
