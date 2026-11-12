/**
 * Route smoke tests: every app/api route handler the rest of the suite never
 * loaded (21 of them when this file was written), driven through the real
 * exports with plain Request objects in multi-user mode. Per route: a
 * malformed body or parameter answers 400, an unknown id 404 (or the route's
 * own not-found shape), and one happy path 2xx. Routes that only wrap an
 * already-tested function get the happy path and the not-found case.
 *
 * Two sweeps over ALL routes follow the table: no identity is 401, and a plain
 * user is 403 admin_only on every admin handler.
 *
 * Engines and the network are faked where a route calls out: the describe
 * route's cheap-slot model answers through a stubbed fetch.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-routes-smoke-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth-test.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_LIBRARY_DIR;
delete process.env.LH_ADMIN_GROUP;
delete process.env.OPENROUTER_API_KEY;
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

const { runAsTenant } = await import("../src/core/tenant-context.ts");
const { emit } = await import("../src/core/events.ts");
const { stores } = await import("../src/server/stores.ts");
const { extraction } = await import("../src/server/chat-handler.ts");

const USER = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ADMIN = "0b8f1d52-6a3c-4f7e-9d21-5e4c8a7b3f10";
const tenant = (id: string) => ({ id, name: id, isAdmin: false });

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
type RouteModule = Record<string, Handler | unknown>;
const load = (file: string) => import(`../app/api/${file}/route.ts`) as Promise<RouteModule>;

const routes = {
	abort: await load("activity/abort"),
	activity: await load("activity"),
	asset: await load("chats/[id]/drawings/assets/[assetId]"),
	assets: await load("chats/[id]/drawings/assets"),
	chats: await load("chats"),
	describe: await load("documents/[id]/describe"),
	reindex: await load("documents/reindex"),
	docSearch: await load("documents/search"),
	events: await load("events"),
	graph: await load("graph"),
	node: await load("graph/nodes/[id]"),
	positions: await load("graph/positions"),
	renderSettings: await load("graph/render-settings"),
	status: await load("graph/status"),
	backfill: await load("graph/topics/backfill"),
	jobs: await load("jobs"),
	knowledge: await load("knowledge"),
	attribute: await load("learner/attribute"),
	learner: await load("learner"),
	okf: await load("okf/export"),
	push: await load("push"),
	search: await load("search"),
	months: await load("usage/months"),
};
const docImport = await load("documents/import");

interface Call {
	user?: string;
	url?: string;
	body?: unknown;
	raw?: BodyInit;
	params?: Record<string, string>;
	headers?: Record<string, string>;
}
/** Invoke one exported handler the way Next would. */
function call(route: RouteModule, method: string, c: Call = {}): Promise<Response> {
	const handler = route[method] as Handler;
	assert.equal(typeof handler, "function", `route exports no ${method}`);
	const headers: Record<string, string> = { ...(c.user === undefined ? { "x-auth-request-user": USER } : c.user ? { "x-auth-request-user": c.user } : {}), ...c.headers };
	if (c.body !== undefined) headers["content-type"] = "application/json";
	const init: RequestInit = { method, headers };
	if (c.body !== undefined) init.body = JSON.stringify(c.body);
	else if (c.raw !== undefined) init.body = c.raw;
	return handler(new Request(c.url ?? "http://example.com/x", init), { params: Promise.resolve(c.params ?? {}) });
}
const json = async (res: Response) => (await res.json()) as any;
function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => (cond() ? resolve() : Date.now() - started > timeoutMs ? reject(new Error(`timeout waiting for ${what}`)) : void setTimeout(tick, 10));
		tick();
	});
}

/** One table row: what a request answers. */
interface Row {
	name: string;
	run: () => Promise<Response>;
	status: number;
	/** Extra assertions on the parsed JSON body (when the answer is JSON). */
	body?: (body: any) => void;
}
function table(rows: Row[]): void {
	for (const row of rows) {
		it(row.name, async () => {
			const res = await row.run();
			const text = await res.clone().text();
			assert.equal(res.status, row.status, `${row.name}: got ${res.status} ${text.slice(0, 200)}`);
			if (row.body) row.body(JSON.parse(text));
		});
	}
}

describe("activity", () => {
	const abort = (body: unknown, raw?: string) => () => call(routes.abort, "POST", raw === undefined ? { body } : { raw, headers: { "content-type": "application/json" } });
	table([
		{ name: "abort: a body that is not JSON is 400", run: abort(undefined, "{not json"), status: 400, body: (b) => assert.equal(b.error, "Invalid JSON body") },
		{ name: "abort: an unknown kind is 400", run: abort({ kind: "nope", id: "x" }), status: 400 },
		{ name: "abort: a missing id is 400", run: abort({ kind: "job" }), status: 400 },
		{ name: "abort: an id with odd characters is 400", run: abort({ kind: "job", id: "a b/../c" }), status: 400, body: (b) => assert.equal(b.error, "Invalid id") },
		{ name: "abort: an unknown job is 404 not_found", run: abort({ kind: "job", id: "job_nope" }), status: 404, body: (b) => assert.deepEqual(b, { ok: false, reason: "not_found" }) },
		{ name: "abort: a turn that is not running is 409 not_running", run: abort({ kind: "turn", id: "chat_nope" }), status: 409, body: (b) => assert.deepEqual(b, { ok: false, reason: "not_running" }) },
		{ name: "abort: stopping an extraction with nothing in flight is 200", run: abort({ kind: "extraction", id: "src_nope" }), status: 200, body: (b) => assert.deepEqual(b, { ok: true }) },
		{ name: "abort: stopping a scan with nothing in flight is 200", run: abort({ kind: "scan", id: "scan_nope" }), status: 200, body: (b) => assert.deepEqual(b, { ok: true }) },
		{
			name: "feed: an idle server lists no jobs, extractions or scans",
			run: () => call(routes.activity, "GET"),
			status: 200,
			body: (b) => assert.deepEqual([b.jobs, b.extractions, b.scans, typeof b.graphRevision], [[], [], [], "number"]),
		},
	]);
});

describe("jobs", () => {
	table([
		{ name: "a missing chatId is 400", run: () => call(routes.jobs, "GET"), status: 400 },
		{ name: "a chatId with odd characters is 400", run: () => call(routes.jobs, "GET", { url: "http://example.com/x?chatId=a/b" }), status: 400 },
		{ name: "an unknown chat has no jobs and no turn", run: () => call(routes.jobs, "GET", { url: "http://example.com/x?chatId=chat_nope" }), status: 200, body: (b) => assert.deepEqual(b, { jobs: [], turnInFlight: false }) },
	]);
});

describe("drawing assets", () => {
	let chatId = "";
	let assetId = "";
	it("setup: a chat and an uploaded PNG", async () => {
		chatId = (await json(await call(routes.chats, "POST", { body: { title: "assets" } }))).id;
		const png = new Uint8Array(33);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const form = new FormData();
		form.append("file", new File([png as BlobPart], "a.png", { type: "image/png" }));
		const res = await call(routes.assets, "POST", { raw: form, params: { id: chatId } });
		assert.equal(res.status, 200);
		assetId = (await json(res)).assetId;
	});
	table([
		{ name: "an unknown chat is 404", run: () => call(routes.asset, "GET", { params: { id: "chat_nope", assetId: "x" } }), status: 404 },
		{ name: "an unknown asset of a real chat is 404", run: () => call(routes.asset, "GET", { params: { id: chatId, assetId: "nope" } }), status: 404 },
		{
			name: "the asset is served as an immutable image",
			run: async () => {
				const res = await call(routes.asset, "GET", { params: { id: chatId, assetId } });
				assert.equal(res.headers.get("content-type"), "image/png");
				assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
				return res;
			},
			status: 200,
		},
	]);
});

describe("documents: describe, reindex, search", () => {
	let docId = "";
	it("setup: one stored document (extraction stubbed)", async () => {
		extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
		const text = `---\ntitle: "Filename-ish title"\nsummary: "s"\ntopics: []\n---\n\n# Notes\n\n${Array.from({ length: 150 }, (_, i) => `entropy${i}`).join(" ")}`;
		const form = new FormData();
		form.append("files", new File([text], "n.md"));
		const res = await call(docImport, "POST", { raw: form });
		assert.equal(res.status, 202);
		docId = (await json(res)).results[0].docId;
	});

	/** An OpenAI-style streamed answer holding one tool call. */
	const toolCallAnswer = (name: string, args: unknown) => {
		const chunk = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
		return new Response(
			chunk({ id: "fake", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }) +
				chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
				"data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	it("describe: an unknown document is 404", async () => {
		assert.equal((await call(routes.describe, "POST", { params: { id: "doc_000000000000" } })).status, 404);
	});
	it("describe: with no model configured the failure is reported, not swallowed", async () => {
		const res = await call(routes.describe, "POST", { params: { id: docId } });
		assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
		assert.equal((await json(res)).code, "models_not_configured");
	});
	it("describe: with a cheap model it regenerates title, summary and topics (200)", async () => {
		// The shared policy gives users a cheap slot; the key and the stubbed provider answer.
		const model = { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" };
		const policy = { slots: { strong: model, cheap: model }, allowedModels: [`${model.provider}:${model.id}`], monthlyCapUsd: 5 };
		process.env.OPENROUTER_API_KEY = "test-key-describe"; // a model is only valid with its provider's key
		const defaults = await load("admin/policy/defaults");
		assert.equal((await call(defaults, "PUT", { user: ADMIN, body: policy, headers: { "x-auth-request-groups": "/learnharness-admin" } })).status, 204);
		globalThis.fetch = (async () => toolCallAnswer("describe_document", { title: "Entropy, explained", summary: "A short summary.", topics: [] })) as typeof fetch;
		try {
			const res = await call(routes.describe, "POST", { params: { id: docId } });
			assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
			assert.equal((await json(res)).ok, true);
		} finally {
			globalThis.fetch = realFetch;
			delete process.env.OPENROUTER_API_KEY;
		}
		const one = await load("documents/[id]");
		assert.equal((await json(await call(one, "GET", { params: { id: docId } }))).meta.title, "Entropy, explained");
	});
	table([
		{ name: "reindex answers at once with ok", run: () => call(routes.reindex, "POST"), status: 200, body: (b) => assert.equal(b.ok, true) },
		{ name: "search: no query is 400", run: () => call(routes.docSearch, "GET", { url: "http://example.com/x?q=%20" }), status: 400, body: (b) => assert.equal(b.error, "q is required") },
		{
			name: "search: a query finds the document by keyword",
			run: () => call(routes.docSearch, "GET", { url: "http://example.com/x?q=entropy3&limit=3" }),
			status: 200,
			body: (b) => assert.ok(b.hits.length > 0 && b.hits.length <= 3 && ["keyword", "hybrid"].includes(b.mode)),
		},
	]);
});

describe("graph", () => {
	const seed = (id: string) =>
		runAsTenant(tenant(USER), () =>
			stores.graphStore.appendNode({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [{ chatId: "chat_seed", messageId: "" }] }),
		);
	it("setup: two concepts", () => {
		seed("n_one");
		seed("n_two");
	});
	table([
		{
			name: "view: nodes come back, groupBy is accepted",
			run: () => call(routes.graph, "GET", { url: "http://example.com/x?groupBy=topic" }),
			status: 200,
			body: (b) => assert.deepEqual(b.nodes.map((n: { id: string }) => n.id).sort(), ["n_one", "n_two"]),
		},
		{ name: "status: no extraction runs", run: () => call(routes.status, "GET"), status: 200, body: (b) => assert.deepEqual(b, { runs: [] }) },
		{ name: "positions: a body that is not JSON is 400", run: () => call(routes.positions, "PUT", { raw: "{nope" }), status: 400 },
		{ name: "positions: unknown ids are dropped, nothing written", run: () => call(routes.positions, "PUT", { body: { ghost: { x: 1, y: 2 } } }), status: 200, body: (b) => assert.deepEqual(b, { positions: {} }) },
		{ name: "positions: garbage coordinates are dropped", run: () => call(routes.positions, "PUT", { body: { n_one: { x: "a", y: null } } }), status: 200, body: (b) => assert.deepEqual(b, { positions: {} }) },
		{
			name: "positions: a known node is committed and clamped",
			run: () => call(routes.positions, "PUT", { body: { n_one: { x: 5, y: 1e12 }, n_two: { x: -3, y: 4 } } }),
			status: 200,
			body: (b) => assert.deepEqual(b, { positions: { n_one: { x: 5, y: 1e6 }, n_two: { x: -3, y: 4 } } }),
		},
		{ name: "render settings: nothing saved yet reads as null", run: () => call(routes.renderSettings, "GET"), status: 200, body: (b) => assert.equal(b, null) },
		{ name: "render settings: a body that is not JSON is 400", run: () => call(routes.renderSettings, "PUT", { raw: "{nope" }), status: 400 },
		{
			name: "render settings: garbage is sanitized, not refused, and is what the next read returns",
			run: async () => {
				const put = await call(routes.renderSettings, "PUT", { body: { nodeSize: "huge", groupBy: "topic", clusterLabels: 7 } });
				const saved = await json(put.clone());
				const again = await json(await call(routes.renderSettings, "GET"));
				assert.deepEqual(again, saved);
				assert.equal(saved.groupBy, "topic");
				assert.equal(saved.sizeUnits, "world");
				assert.equal(typeof saved.nodeSize, "number");
				return put;
			},
			status: 200,
		},
		{ name: "delete node: an unknown concept is 404", run: () => call(routes.node, "DELETE", { params: { id: "n_ghost" } }), status: 404 },
		{ name: "delete node: a known concept is removed, with the new graph revision", run: () => call(routes.node, "DELETE", { params: { id: "n_two" } }), status: 200, body: (b) => assert.equal(typeof b.graphRevision, "number") },
		{ name: "view: the deleted concept is gone", run: () => call(routes.graph, "GET"), status: 200, body: (b) => assert.deepEqual(b.nodes.map((n: { id: string }) => n.id), ["n_one"]) },
		{ name: "topic backfill: a user with no concepts has nothing to file (200)", run: () => call(routes.backfill, "POST", { user: OTHER }), status: 200, body: (b) => assert.deepEqual(b, { started: false, pending: 0 }) },
	]);
	it("topic backfill: the user's own untagged concept starts a background run (202); it stops honestly without a key", async () => {
		const logged: string[] = [];
		const info = mock.method(console, "info", (line: string) => void logged.push(String(line)));
		try {
			const res = await call(routes.backfill, "POST");
			assert.equal(res.status, 202);
			assert.deepEqual(await json(res), { started: true, running: false, pending: 1 });
			await waitFor(() => logged.length >= 2, "the backfill to finish");
			assert.match(logged[0]!, /stopped: No OpenRouter key is set/);
		} finally {
			info.mock.restore();
		}
	});
});

describe("learner, knowledge, export, search, usage", () => {
	table([
		{ name: "learner: the snapshot is derived and answers 200", run: () => call(routes.learner, "GET"), status: 200 },
		{ name: "knowledge: the view is derived and answers 200", run: () => call(routes.knowledge, "GET"), status: 200 },
		{ name: "attribute: nothing pending is {chats: 0, rows: 0}", run: () => call(routes.attribute, "POST"), status: 200, body: (b) => assert.deepEqual([b.chats, b.rows], [0, 0]) },
		{
			name: "export: a zip attachment",
			run: async () => {
				const res = await call(routes.okf, "GET");
				assert.equal(res.headers.get("content-type"), "application/zip");
				assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename=/);
				const bytes = new Uint8Array(await res.clone().arrayBuffer());
				assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b], "a zip starts with PK");
				return res;
			},
			status: 200,
		},
		{ name: "search status: reports availability without a key", run: () => call(routes.search, "GET"), status: 200, body: (b) => assert.equal(typeof b.available, "boolean") },
		{ name: "usage months: the twelve-month strip answers 200", run: () => call(routes.months, "GET"), status: 200 },
	]);
});

describe("push registration", () => {
	const subscription = { endpoint: "https://push.example.com/endpoint/1", keys: { p256dh: "p256dh-key", auth: "auth-key" } };
	const stored = (user: string) => runAsTenant(tenant(user), () => stores.pushStore.listSubscriptions().map((s) => s.endpoint));
	table([
		{ name: "GET hands out the VAPID public key", run: () => call(routes.push, "GET"), status: 200, body: (b) => assert.ok(typeof b.publicKey === "string" && b.publicKey.length > 20) },
		{ name: "POST without a subscription is 400", run: () => call(routes.push, "POST", { body: { label: "x" } }), status: 400 },
		{ name: "POST with an endpoint that is not a URL is 400", run: () => call(routes.push, "POST", { body: { subscription: { ...subscription, endpoint: "nope" } } }), status: 400 },
		{ name: "POST with a body that is not JSON is 400", run: () => call(routes.push, "POST", { raw: "{nope" }), status: 400 },
		{ name: "POST from another site is refused 403", run: () => call(routes.push, "POST", { body: { subscription }, headers: { "sec-fetch-site": "cross-site" } }), status: 403, body: (b) => assert.equal(b.error, "same_origin_required") },
		{ name: "POST registers the device (204)", run: () => call(routes.push, "POST", { body: { subscription, label: "Phone" } }), status: 204 },
		{ name: "DELETE without an endpoint is 400", run: () => call(routes.push, "DELETE", { body: {} }), status: 400 },
	]);
	it("the device belongs to the user who registered it", () => {
		assert.deepEqual(stored(USER), [subscription.endpoint]);
		assert.deepEqual(stored(OTHER), []);
	});
	it("another user's DELETE of that endpoint changes nothing; the owner's removes it (204)", async () => {
		assert.equal((await call(routes.push, "DELETE", { user: OTHER, body: { endpoint: subscription.endpoint } })).status, 204);
		assert.deepEqual(stored(USER), [subscription.endpoint]);
		assert.equal((await call(routes.push, "DELETE", { body: { endpoint: subscription.endpoint } })).status, 204);
		assert.deepEqual(stored(USER), []);
	});
});

describe("events", () => {
	it("the stream is SSE and carries this user's events only", async () => {
		const res = await call(routes.events, "GET");
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = res.body!.getReader();
		try {
			// Frames arrive in emit order: the other user's event first, then this user's.
			runAsTenant(tenant(OTHER), () => emit("record-changed", { chatId: "chat_of_other" }));
			runAsTenant(tenant(USER), () => emit("record-changed", { chatId: "chat_of_user" }));
			const { value } = await reader.read();
			const frame = new TextDecoder().decode(value);
			assert.match(frame, /^event: record-changed\n/);
			assert.ok(frame.includes("chat_of_user") && !frame.includes("chat_of_other"), frame);
		} finally {
			await reader.cancel();
		}
	});
});

// ─── sweeps over every route file ───────────────────────────────────────────

const apiDir = path.join(import.meta.dirname, "..", "app", "api");
function routeFiles(d: string): string[] {
	return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(d, e.name);
		return e.isDirectory() ? routeFiles(p) : e.name === "route.ts" ? [p] : [];
	});
}
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Every exported handler as [route label, method, handler], health excluded (it is deliberately open). */
async function handlers(filter: (rel: string) => boolean = () => true): Promise<[string, string, Handler][]> {
	const out: [string, string, Handler][] = [];
	for (const file of routeFiles(apiDir).sort()) {
		const rel = path.relative(apiDir, path.dirname(file));
		if (rel === "health" || !filter(rel)) continue;
		const mod = (await import(file)) as RouteModule;
		for (const m of METHODS) if (typeof mod[m] === "function") out.push([rel, m, mod[m] as Handler]);
	}
	return out;
}
const anyParams = { params: Promise.resolve({ id: "x", section: "general", segment: ["x"], callId: "x", drawingId: "x", assetId: "x" }) };

describe("every route", () => {
	it("answers 401 without an identity, before doing anything", async () => {
		const all = await handlers();
		const declared = routeFiles(apiDir).filter((f) => !f.endsWith(`${path.sep}health${path.sep}route.ts`)).reduce((n, f) => n + (fs.readFileSync(f, "utf8").match(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm)?.length ?? 0), 0);
		assert.equal(all.length, declared, "every exported method was found and exercised");
		for (const [rel, method, handler] of all) {
			const res = await handler(new Request("http://example.com/x", { method }), anyParams);
			assert.equal(res.status, 401, `${method} /api/${rel} answered ${res.status} to an anonymous request`);
		}
	});

	it("answers 403 admin_only to a plain user on every admin handler", async () => {
		const admin = await handlers((rel) => rel.startsWith("admin"));
		assert.equal(admin.length, 14);
		for (const [rel, method, handler] of admin) {
			const res = await handler(
				new Request("http://example.com/x", {
					method,
					headers: { "x-auth-request-user": USER, "x-auth-request-groups": "/learnharness", "content-type": "application/json" },
					...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
				}),
				anyParams,
			);
			assert.equal(res.status, 403, `${method} /api/${rel} answered ${res.status} to a plain user`);
			assert.deepEqual(await res.json(), { error: "admin_only" }, `${method} /api/${rel}`);
		}
	});
});
