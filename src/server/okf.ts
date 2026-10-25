/**
 * THE LIBRARY SERVICE: keeps the generated OKF bundle (data/okf) fresh and
 * renders the learner's download. Pure rendering lives in core/okf.ts; the
 * OkfBundleStore adapter is the sole writer of the tree; this service only
 * decides WHEN to rebuild and WHAT goes in.
 *
 * Freshness is lazy: `ensureFresh()` runs before every library tool call
 * (and once at boot). It computes a cheap stat-based stamp of everything the
 * bundle derives from and rebuilds, atomically, only when the stamp differs
 * from the one stored beside the bundle. Concurrent calls share one rebuild
 * (single-flight). It never throws (a failed rebuild is logged and the
 * previous complete bundle keeps serving) and never runs under
 * NODE_ENV=test unless the deps say `force: true` - golden fixtures stay
 * byte-identical and no suite builds a bundle by accident.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { LEDGER_FILES, PATHS, SETTINGS_FILE, TOPIC_ALIASES_FILE } from "../../config.ts";
import type { LearnerSnapshot, OkfFile } from "../core/contracts/okf.ts";
import { getGraph } from "../core/graph.ts";
import { OKF_RENDER_REV, renderOkfBundle } from "../core/okf.ts";
import { renderOkfViewer } from "../core/okf-viz.ts";
import type { ChatStore, DocumentStore, GraphStore, OkfBundleStore } from "../core/ports.ts";
import type { UserSettings } from "../core/settings.ts";
import { documentToolsEnabled, graphToolsEnabled, resolveSettings } from "../core/settings-resolution.ts";

export interface LibraryDeps {
	okfStore: OkfBundleStore;
	graphStore: GraphStore;
	documentStore: DocumentStore;
	chatStore: Pick<ChatStore, "listChats">;
	settings: () => UserSettings | null;
	/** The learner model's snapshot (later PR); absent = no me/ directory. */
	learner?: () => LearnerSnapshot | undefined;
	now?: () => Date;
	/** Rebuild even under NODE_ENV=test (suites that exercise the service). */
	force?: boolean;
}

export interface Library {
	/** The bundle root the agents' file tools are confined to. */
	root: string;
	/** Rebuild the bundle when its sources changed. Never throws. */
	ensureFresh(): Promise<void>;
	/** The full download: every document, the graph unless graph.enabled is off,
	 *  the agent gates NOT applied (they govern agents, not the learner), plus viz.html. */
	renderExport(): OkfFile[];
	/** The freshness stamp of the current sources. */
	sourceStamp(): string;
}

const statLine = (file: string): string => {
	try {
		const s = fs.statSync(file);
		return `${file}:${s.mtimeMs}:${s.size}`;
	} catch {
		return `${file}:-`;
	}
};

const listDir = (dir: string): string[] => {
	try {
		return fs.readdirSync(dir).sort();
	} catch {
		return [];
	}
};

export function createLibrary(deps: LibraryDeps): Library {
	const now = () => (deps.now ?? (() => new Date()))();

	/** Everything the bundle derives from, as a hash of mtime+size lines. */
	function sourceStamp(): string {
		const lines: string[] = [`rev:${OKF_RENDER_REV}`];
		for (const f of [LEDGER_FILES.nodes, LEDGER_FILES.chains, LEDGER_FILES.topics, TOPIC_ALIASES_FILE, SETTINGS_FILE]) {
			lines.push(statLine(f));
		}
		for (const id of listDir(PATHS.documents)) lines.push(statLine(path.join(PATHS.documents, id, "meta.json")));
		// Chat file NAMES (a deleted chat changes the stamp) + the newest mtime (a rename, a new message).
		const chats = listDir(PATHS.chats).filter((f) => f.endsWith(".json"));
		let maxChat = 0;
		for (const f of chats) {
			try {
				maxChat = Math.max(maxChat, fs.statSync(path.join(PATHS.chats, f)).mtimeMs);
			} catch {
				/* vanished between readdir and stat */
			}
		}
		lines.push(`chats:${chats.join(",")}:${maxChat}`);
		const attributions = path.join(PATHS.data, "learner", "attributions.jsonl");
		if (fs.existsSync(attributions)) lines.push(statLine(attributions));
		// me/ ("due") depends on the clock: refresh daily.
		lines.push(`day:${now().toISOString().slice(0, 10)}`);
		return createHash("sha256").update(lines.join("\n")).digest("hex");
	}

	function buildInput(gates: { documents: boolean; graph: boolean }) {
		const graph = getGraph(deps.graphStore);
		const documents = deps.documentStore.listMetas().flatMap((meta) => {
			const text = deps.documentStore.readMarkdown(meta.id);
			return text === null ? [] : [{ meta, text }];
		});
		return {
			nodes: graph.nodes,
			chains: graph.chains,
			topics: deps.graphStore.readTopics(),
			aliases: deps.graphStore.readTopicAliases(),
			documents,
			chats: deps.chatStore.listChats().map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt })),
			...(deps.learner ? { learner: deps.learner() } : {}),
			gates,
			now: now().toISOString(),
		};
	}

	let inflight: Promise<void> | null = null;

	async function rebuildIfStale(): Promise<void> {
		await Promise.resolve(); // let a concurrent caller see `inflight` before any work
		try {
			const stamp = sourceStamp();
			if (deps.okfStore.readStamp() === stamp) return;
			const effective = resolveSettings(deps.settings());
			const files = renderOkfBundle(
				buildInput({ documents: documentToolsEnabled(effective), graph: graphToolsEnabled(effective) }),
			);
			deps.okfStore.replaceAll(files);
			deps.okfStore.writeStamp(stamp);
		} catch (err) {
			// The previous complete bundle (or "being built") keeps serving; the next call retries.
			console.error("[okf] bundle rebuild failed:", err);
		}
	}

	return {
		root: PATHS.okf,
		ensureFresh() {
			if (process.env.NODE_ENV === "test" && !deps.force) return Promise.resolve();
			if (!inflight) inflight = rebuildIfStale().finally(() => void (inflight = null));
			return inflight;
		},
		renderExport() {
			const effective = resolveSettings(deps.settings());
			const files = renderOkfBundle(buildInput({ documents: true, graph: effective.graph.enabled !== false }));
			return [...files, { path: "viz.html", content: renderOkfViewer(files, undefined, now()) }];
		},
		sourceStamp,
	};
}
