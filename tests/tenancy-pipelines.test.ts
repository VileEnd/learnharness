/**
 * Two users, one process, the real route handlers: what user A creates
 * (chat, turn, background job and its wake delivery, document and its
 * replace/delete, drawing, concepts) must never be reachable by user B and
 * must never touch B's files. Production runs with LH_MULTI_USER=1; the
 * tenancy-* suites pin identity and paths, this one drives the pipelines.
 *
 * Seams (the same ones chat-flow / jobs / uploads tests use): engines are
 * pi-ai faux providers injected through handleChatRequest's agent factory
 * (POST /api/chat has no engine seam, so the route's own wrapper is rebuilt
 * around it: same withTenant, same handler), the wake pipeline's turn runner
 * is replaced by one that runs the faux engine and records the tenant it ran
 * as, and the document extraction is stubbed on the shared instance. No
 * network: the researcher's search provider is a stub.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { SearchProvider } from "../src/core/search.ts";

// Isolated multi-user data dir BEFORE any config-loading import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tenancy-pipelines-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth-test.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_LIBRARY_DIR;
delete process.env.LH_ADMIN_GROUP;
// The key-presence turn gate reads env-first truth (chat-flow does the same).
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { runAsTenant, requireTenant } = await import("../src/core/tenant-context.ts");
const { withTenant } = await import("../src/server/tenant.ts");
const { stores } = await import("../src/server/stores.ts");
const { extraction, handleChatInput, handleChatRequest } = await import("../src/server/chat-handler.ts");
const { deliverJobResult, discardChatDeliveries, setTurnRunner } = await import("../src/server/jobs.ts");
const { createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { createTeacherTools } = await import("../src/agent/tools.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");

const chatsRoute = await import("../app/api/chats/route.ts");
const chatRoute = await import("../app/api/chats/[id]/route.ts");
const chatSettingsRoute = await import("../app/api/chats/[id]/settings/route.ts");
const chatStreamRoute = await import("../app/api/chats/[id]/stream/route.ts");
const drawingsRoute = await import("../app/api/chats/[id]/drawings/route.ts");
const drawingRoute = await import("../app/api/chats/[id]/drawings/[drawingId]/route.ts");
const assetsRoute = await import("../app/api/chats/[id]/drawings/assets/route.ts");
const assetRoute = await import("../app/api/chats/[id]/drawings/assets/[assetId]/route.ts");
const draftRoute = await import("../app/api/chats/[id]/drawings/drafts/[callId]/route.ts");
const jobsRoute = await import("../app/api/jobs/route.ts");
const abortRoute = await import("../app/api/activity/abort/route.ts");
const activityRoute = await import("../app/api/activity/route.ts");
const docsRoute = await import("../app/api/documents/route.ts");
const docRoute = await import("../app/api/documents/[id]/route.ts");
const docImportRoute = await import("../app/api/documents/import/route.ts");
const docCheckRoute = await import("../app/api/documents/check/route.ts");
const docSearchRoute = await import("../app/api/documents/search/route.ts");
const graphRoute = await import("../app/api/graph/route.ts");
const graphNodeRoute = await import("../app/api/graph/nodes/[id]/route.ts");
const knowledgeRoute = await import("../app/api/knowledge/route.ts");
const learnerRoute = await import("../app/api/learner/route.ts");
const okfRoute = await import("../app/api/okf/export/route.ts");
const policyDefaultsRoute = await import("../app/api/admin/policy/defaults/route.ts");

// ─── identities and request helpers ─────────────────────────────────────────

const A = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ADMIN = "0b8f1d52-6a3c-4f7e-9d21-5e4c8a7b3f10";

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const headersOf = (user: string, extra?: HeadersInit) => ({
	"x-auth-request-user": user,
	...(user === ADMIN ? { "x-auth-request-groups": "/learnharness,/learnharness-admin" } : {}),
	...(extra as Record<string, string>),
});

const get = (user: string, url = "http://example.com/x") => new Request(url, { headers: headersOf(user) });
const send = (user: string, method: string, body: unknown, url = "http://example.com/x") =>
	new Request(url, { method, headers: headersOf(user, { "content-type": "application/json" }), body: JSON.stringify(body) });

/** POST /api/chat's own wrapper around the real handler, with the faux engine seam. */
const chatPost = withTenant((req: Request) => handleChatRequest(req, agentFactory));

function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 10);
		};
		tick();
	});
}

// ─── faux engines: one script queue per chat ────────────────────────────────

interface Script {
	engine: PiEngine;
	tools?: ReturnType<typeof createTeacherTools>;
}
const scripts = new Map<string, Script[]>();
const queueScript = (chatId: string, script: Script) => scripts.set(chatId, [...(scripts.get(chatId) ?? []), script]);

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const sayEngine = (text: string) => fauxEngine([fauxAssistantMessage([fauxText(text)])]);

/** A turn that never ends until aborted (the jobs/chat-flow pattern). */
function hangingEngine(): PiEngine {
	const step = (_ctx: unknown, opts: { signal?: AbortSignal } | undefined) =>
		new Promise((resolve) => {
			if (opts?.signal?.aborted) return resolve(fauxAssistantMessage("late"));
			opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		});
	return fauxEngine([step as unknown as FauxResponseStep]);
}

function agentFactory(opts: Parameters<NonNullable<Parameters<typeof handleChatRequest>[1]>>[0]) {
	const chatId = opts.chatId ?? "";
	const script = scripts.get(chatId)?.shift();
	assert.ok(script, `no script queued for chat ${chatId}`);
	return createTeacherAgent(undefined, { engine: script.engine, tools: script.tools, messages: opts.messages });
}

/** The wake pipeline's turn runner: the faux engine, and who it ran as. */
const wakeRanAs: string[] = [];
setTurnRunner(async (chatId, input) => {
	wakeRanAs.push(requireTenant().id);
	const res = await handleChatInput(chatId, input, agentFactory, { canvasCapable: false });
	await res.arrayBuffer().catch(() => undefined);
	return res.status;
});

const RESEARCH_INPUT = { question: "What is the latest stable sigma.js version?", context: "Choosing a graph rendering library." };
const BRIEF = "## Summary\nsigma.js v3 is current.\n\n## Sources\n- sigma.js docs (https://www.sigmajs.org/docs)";
const stubSearch: SearchProvider = {
	id: "tavily",
	async search() {
		return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
	},
};

// ─── file-tree helpers ──────────────────────────────────────────────────────

function filesUnder(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		if (!fs.existsSync(d)) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(p);
		}
	};
	walk(root);
	return out.sort();
}
const userRoot = (id: string) => path.join(dir, "users", id);

// ─── shared state of the scenario ───────────────────────────────────────────

const S = {
	chatA: "",
	chatB: "",
	jobA: "",
	docA: "",
	drawingA: "",
	assetA: "",
	nodeA: "",
	/** Every id A's actions produced, labelled: the leak scan looks for all of them in B's tree. */
	idsA: {} as Record<string, string>,
	idsB: {} as Record<string, string>,
};
const extractedAs: string[] = [];

before(() => {
	// A document extraction that writes one concept for its source, like the real pipeline's merge.
	extraction.importNotes = async (input) => {
		extractedAs.push(requireTenant().id);
		stores.graphStore.appendNode({
			id: `concept_${input.id}`,
			name: `Concept of ${input.title}`,
			statement: "A statement about photosynthesis.",
			aliases: [],
			createdAt: "2026-01-01T00:00:00Z",
			provenance: [{ chatId: input.id ?? "", messageId: "" }],
		});
		return { nodes: 1, chains: 0 };
	};
	researchModelOverride.current = fauxEngine([
		fauxAssistantMessage([fauxToolCall("web_search", { query: "sigma.js latest version" }, { id: "ws1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText(BRIEF)]),
	]);
});
after(() => {
	researchModelOverride.current = undefined;
	for (const chatId of [S.chatA, S.chatB]) if (chatId) discardChatDeliveries(chatId);
});

/** A markdown file with front matter (skips the describe model); unique text per `body`. */
const doc = (name: string, body: string) =>
	new File(
		[`---\ntitle: "About ${body}"\nsummary: "s"\ntopics: []\n---\n\n# Notes\n\n${Array.from({ length: 200 }, (_, i) => `${body}${i}`).join(" ")}`],
		name,
	);
const multipart = (user: string, file: File, decisions?: unknown[]) => {
	const form = new FormData();
	form.append("files", file);
	if (decisions) form.append("decisions", JSON.stringify(decisions));
	return new Request("http://example.com/x", { method: "POST", headers: headersOf(user), body: form });
};

function png(): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(bytes.buffer).setUint32(16, 64);
	new DataView(bytes.buffer).setUint32(20, 64);
	return bytes;
}
const SCENE = { version: 1, objects: [{ id: "s1", z: 0, type: "stroke", brush: "pen", color: "ink", size: 3, points: [[0, 0, 1], [4, 4, 1]] }] };

const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("two users through the real routes", () => {
	it("each user creates a chat and runs one turn on their own faux engine", async () => {
		// Users are restricted by policy (no catalog offline, so none is built in): the admin's
		// defaults, the one shared file here, give every user the strong slot a session is born on.
		const model = { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" };
		const policy = { slots: { strong: model }, allowedModels: [`${model.provider}:${model.id}`], monthlyCapUsd: 5 };
		assert.equal((await policyDefaultsRoute.PUT(send(ADMIN, "PUT", policy))).status, 204);
		assert.equal((await policyDefaultsRoute.PUT(send(A, "PUT", policy))).status, 403, "a plain user cannot set the shared policy");

		for (const [user, key, label] of [[A, "chatA", "A"], [B, "chatB", "B"]] as const) {
			const created = await chatsRoute.POST(send(user, "POST", { title: `Session of ${label}` }));
			assert.equal(created.status, 200);
			S[key] = (await json(created)).id;
			const stamped = await json(await chatRoute.GET(get(user), ctx({ id: S[key] })));
			assert.deepEqual(stamped.settings.model, model, `${label}'s session is born on the policy's strong slot`);
			queueScript(S[key], { engine: sayEngine(`Reply for ${label}.`) });
			const ack = await chatPost(send(user, "POST", { chatId: S[key], input: { type: "text", text: `hello from ${label}` } }));
			assert.equal(ack.status, 200);
			await waitFor(() => !isTurnRunning(S[key]), `${label}'s turn to settle`);
		}
		S.idsA.chat = S.chatA;
		S.idsB.chat = S.chatB;

		for (const [user, chatId, label, other] of [[A, S.chatA, "A", "B"], [B, S.chatB, "B", "A"]] as const) {
			const record = await json(await chatRoute.GET(get(user), ctx({ id: chatId })));
			assert.equal(record.messages.length, 2, `${label}: user message + reply`);
			const text = JSON.stringify(record.messages);
			assert.ok(text.includes(`hello from ${label}`) && text.includes(`Reply for ${label}.`));
			assert.ok(!text.includes(`from ${other}`) && !text.includes(`Reply for ${other}.`));
			const list = await json(await chatsRoute.GET(get(user)));
			assert.deepEqual(list.chats.map((c: { id: string }) => c.id), [chatId], `${label} sees only their own chat`);
		}
	});

	it("a background job of A is delivered by the wake pipeline into A's chat only", async () => {
		const runner = createJobRunner({ chatStore: stores.chatStore, jobStore: stores.jobStore, deliver: deliverJobResult, searchProvider: () => stubSearch });
		const tools = createTeacherTools({
			chatId: S.chatA,
			chatStore: stores.chatStore,
			jobStore: stores.jobStore,
			spawn: (job, input) => void runner.runJob(job.id, input),
			libraryRoot: "/nonexistent-library",
		});
		// Turn 1 dispatches research; the wake turn (queued second) reacts to the result.
		queueScript(S.chatA, {
			engine: fauxEngine([
				fauxAssistantMessage([fauxText("Checking."), fauxToolCall("research", RESEARCH_INPUT, { id: "call-r1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Waiting for the brief.")]),
			]),
			tools,
		});
		queueScript(S.chatA, { engine: sayEngine("The brief arrived.") });
		const bBefore = filesUnder(userRoot(B));

		const ack = await chatPost(send(A, "POST", { chatId: S.chatA, input: { type: "text", text: "research sigma" } }));
		assert.equal(ack.status, 200);

		const steerLanded = () =>
			runAsTenant({ id: A, name: A, isAdmin: false }, () =>
				(stores.chatStore.getChat(S.chatA)?.messages ?? []).some((m) => m.role === "custom" && JSON.stringify(m).includes("sigma.js v3 is current")),
			);
		await waitFor(steerLanded, "the research result to land in A's chat");
		await waitFor(() => !isTurnRunning(S.chatA), "the wake turn to settle");

		const jobs = await json(await jobsRoute.GET(get(A, `http://example.com/api/jobs?chatId=${S.chatA}`)));
		assert.equal(jobs.jobs.length, 1);
		S.jobA = jobs.jobs[0].id;
		S.idsA.job = S.jobA;
		await waitFor(
			() => runAsTenant({ id: A, name: A, isAdmin: false }, () => stores.jobStore.getJob(S.jobA)?.delivery?.status === "delivered"),
			"the delivery bookkeeping",
		);
		assert.equal(jobs.jobs[0].kind, "research");
		assert.ok(wakeRanAs.length >= 1 && wakeRanAs.every((id) => id === A), `the wake turn ran as A, got ${wakeRanAs}`);

		const record = await json(await chatRoute.GET(get(A), ctx({ id: S.chatA })));
		assert.match(JSON.stringify(record.messages), /The brief arrived\./);

		// B's side is untouched: the chat holds its two messages, no job exists, no file appeared.
		const b = await json(await chatRoute.GET(get(B), ctx({ id: S.chatB })));
		assert.equal(b.messages.length, 2);
		assert.doesNotMatch(JSON.stringify(b), /sigma/);
		assert.deepEqual(await json(await jobsRoute.GET(get(B, `http://example.com/api/jobs?chatId=${S.chatB}`))), { jobs: [], turnInFlight: false });
		assert.deepEqual(filesUnder(userRoot(B)), bBefore, "B's files did not change while A's job ran and was delivered");
	});

	it("A imports a text document, replaces it, and the concept follows; B sees nothing", async () => {
		const first = await docImportRoute.POST(multipart(A, doc("one.md", "photosynthesis")));
		assert.equal(first.status, 202);
		const [ticket] = (await json(first)).results;
		assert.equal(ticket.outcome, "started");
		S.docA = ticket.docId;
		S.idsA.doc = S.docA;
		await waitFor(() => extractedAs.length === 1, "A's extraction");
		assert.deepEqual(extractedAs, [A], "the background extraction ran as A");

		const graph = await json(await graphRoute.GET(get(A)));
		const conceptsOf = (g: Record<string, any>) => (g.nodes as { id: string }[]).map((n) => n.id);
		assert.equal(conceptsOf(graph).length, 1);
		S.nodeA = conceptsOf(graph)[0]!;
		S.idsA.node = S.nodeA;

		// Same text again for A is a duplicate; B's check of the SAME file calls it new (B has no library).
		const checkA = await json(await docCheckRoute.POST(multipart(A, doc("copy.md", "photosynthesis"))));
		assert.equal(checkA.results[0].verdict.status, "duplicate");
		const checkB = await json(await docCheckRoute.POST(multipart(B, doc("copy.md", "photosynthesis"))));
		assert.equal(checkB.results[0].verdict.status, "new");

		// Replace: an edited version of the same document keeps the docId and moves to a fresh graph source.
		const edited = new File([(await doc("v2.md", "photosynthesis").text()).replace("photosynthesis7 ", "edited ")], "v2.md");
		const replaced = await docImportRoute.POST(multipart(A, edited, ["replace"]));
		const [rt] = (await json(replaced)).results;
		assert.equal(rt.outcome, "started");
		assert.equal(rt.docId, S.docA);
		await waitFor(() => extractedAs.length === 2, "A's re-extraction");
		const swapped = () =>
			runAsTenant({ id: A, name: A, isAdmin: false }, () => stores.graphStore.readNodes().map((n) => n.id).join() !== `concept_${S.docA}`);
		await waitFor(swapped, "the old source to retire");
		assert.deepEqual(extractedAs, [A, A]);
		const after = await json(await docRoute.GET(get(A), ctx({ id: S.docA })));
		assert.match(after.markdown, /edited/);
		assert.equal(after.meta.filenames.length, 2);

		const nodesNow = conceptsOf(await json(await graphRoute.GET(get(A))));
		assert.equal(nodesNow.length, 1);
		S.nodeA = nodesNow[0]!;
		S.idsA.node = S.nodeA;
	});

	it("A uploads a drawing, an image asset and a draft", async () => {
		const form = new FormData();
		form.append("scene", JSON.stringify(SCENE));
		form.append("png", new File([png() as BlobPart], "d.png", { type: "image/png" }));
		const drawn = await drawingsRoute.POST(new Request("http://example.com/x", { method: "POST", headers: headersOf(A), body: form }), ctx({ id: S.chatA }));
		assert.equal(drawn.status, 200);
		S.drawingA = (await json(drawn)).drawingId;
		S.idsA.drawing = S.drawingA;

		const imageForm = new FormData();
		imageForm.append("file", new File([png() as BlobPart], "a.png", { type: "image/png" }));
		const uploaded = await assetsRoute.POST(new Request("http://example.com/x", { method: "POST", headers: headersOf(A), body: imageForm }), ctx({ id: S.chatA }));
		assert.equal(uploaded.status, 200);
		S.assetA = (await json(uploaded)).assetId;
		S.idsA.asset = S.assetA;

		const draft = await draftRoute.PUT(send(A, "PUT", { scene: SCENE, baseRev: 0 }), ctx({ id: S.chatA, callId: "call_a1" }));
		assert.equal(draft.status, 200);
		S.idsA.draft = "call_a1";

		const back = await drawingRoute.GET(get(A, "http://example.com/x?format=png"), ctx({ id: S.chatA, drawingId: S.drawingA }));
		assert.equal(back.headers.get("content-type"), "image/png");
	});

	it("B's requests for every id A created answer not-found", async () => {
		const notFound = async (res: Response, what: string) => assert.equal(res.status, 404, `${what} should be 404, got ${res.status}`);

		// Chat: read, rename, delete, settings, stream, turn.
		await notFound(await chatRoute.GET(get(B), ctx({ id: S.chatA })), "GET chat");
		await notFound(await chatRoute.PUT(send(B, "PUT", { title: "mine now" }), ctx({ id: S.chatA })), "rename chat");
		await notFound(await chatSettingsRoute.PUT(send(B, "PUT", { canvas: true }), ctx({ id: S.chatA })), "chat settings");
		await notFound(await chatStreamRoute.GET(get(B), ctx({ id: S.chatA })), "chat stream");
		await notFound(await chatPost(send(B, "POST", { chatId: S.chatA, input: { type: "text", text: "hi" } })), "turn on A's chat");
		const del = await chatRoute.DELETE(send(B, "DELETE", {}, "http://example.com/x?mode=preserve-graph"), ctx({ id: S.chatA }));
		assert.ok(del.status === 404, `delete chat should be 404, got ${del.status}`);

		// Job: B's jobs list for A's chat is empty, B's abort of A's job id is not_found.
		assert.deepEqual((await json(await jobsRoute.GET(get(B, `http://example.com/api/jobs?chatId=${S.chatA}`)))).jobs, []);
		const abortJob = await abortRoute.POST(send(B, "POST", { kind: "job", id: S.jobA }));
		assert.equal(abortJob.status, 404);
		assert.deepEqual(await json(abortJob), { ok: false, reason: "not_found" });
		// ...whereas for A the same job exists (settled, hence 409 not_running).
		assert.equal((await abortRoute.POST(send(A, "POST", { kind: "job", id: S.jobA }))).status, 409);

		// Document: read, rename, delete, search.
		await notFound(await docRoute.GET(get(B), ctx({ id: S.docA })), "GET document");
		await notFound(await docRoute.PATCH(send(B, "PATCH", { title: "mine" }), ctx({ id: S.docA })), "rename document");
		await notFound(await docRoute.DELETE(send(B, "DELETE", {}), ctx({ id: S.docA })), "delete document");
		assert.deepEqual((await json(await docsRoute.GET(get(B)))).documents, []);
		const hitsA = await json(await docSearchRoute.GET(get(A, "http://example.com/x?q=photosynthesis3")));
		const hitsB = await json(await docSearchRoute.GET(get(B, "http://example.com/x?q=photosynthesis3")));
		assert.ok(hitsA.hits.length > 0, "A finds their own document");
		assert.deepEqual(hitsB.hits, [], "B's search over their (empty) library finds nothing");

		// Drawing, asset, draft: through A's chat id, and through B's own chat id.
		for (const chatId of [S.chatA, S.chatB]) {
			await notFound(await drawingRoute.GET(get(B), ctx({ id: chatId, drawingId: S.drawingA })), `drawing via ${chatId === S.chatA ? "A's" : "B's"} chat`);
			await notFound(await drawingRoute.GET(get(B, "http://example.com/x?format=png"), ctx({ id: chatId, drawingId: S.drawingA })), "drawing png");
			await notFound(await assetRoute.GET(get(B), ctx({ id: chatId, assetId: S.assetA })), "asset");
			await notFound(await draftRoute.GET(get(B), ctx({ id: chatId, callId: "call_a1" })), "draft read");
		}
		const form = new FormData();
		form.append("scene", JSON.stringify(SCENE));
		form.append("png", new File([png() as BlobPart], "d.png", { type: "image/png" }));
		await notFound(await drawingsRoute.POST(new Request("http://example.com/x", { method: "POST", headers: headersOf(B), body: form }), ctx({ id: S.chatA })), "drawing upload into A's chat");
		await notFound(await draftRoute.PUT(send(B, "PUT", { scene: SCENE, baseRev: 1 }), ctx({ id: S.chatA, callId: "call_a1" })), "draft write into A's chat");

		// Graph node: B's delete of A's concept finds nothing, and A's survives.
		await notFound(await graphNodeRoute.DELETE(send(B, "DELETE", {}), ctx({ id: S.nodeA })), "delete A's concept");
		assert.equal((await json(await graphRoute.GET(get(A)))).nodes.length, 1);
		assert.equal((await json(await graphRoute.GET(get(B)))).nodes.length, 0);

		// Derived views and the export carry nothing of A's.
		for (const [name, route] of [["knowledge", knowledgeRoute], ["learner", learnerRoute]] as const) {
			const asB = JSON.stringify(await json(await route.GET(get(B))));
			for (const [label, id] of Object.entries(S.idsA)) assert.ok(!asB.includes(id), `/api/${name} for B leaked A's ${label}`);
		}
		const exportA = Buffer.from(await (await okfRoute.GET(get(A))).arrayBuffer());
		const exportB = Buffer.from(await (await okfRoute.GET(get(B))).arrayBuffer());
		assert.ok(exportA.length > exportB.length, "A's export holds A's library, B's is the empty bundle");
		assert.ok(!exportB.includes("photosynthesis"), "B's export names nothing of A's document");
	});

	it("B cannot see or stop A's running turn, A can", async () => {
		queueScript(S.chatA, { engine: hangingEngine() });
		const ack = await chatPost(send(A, "POST", { chatId: S.chatA, input: { type: "text", text: "think for a long time" } }));
		assert.equal(ack.status, 200);
		await waitFor(() => runningTurn(S.chatA) !== undefined, "A's turn to be running");

		// A hung job record: the dock's feed lists it for A only.
		const running = runAsTenant({ id: A, name: A, isAdmin: false }, () => stores.jobStore.createJob({ kind: "research", chatId: S.chatA, toolCallId: "call-hung" }));
		const feedA = await json(await activityRoute.GET(get(A)));
		const feedB = await json(await activityRoute.GET(get(B)));
		assert.deepEqual(feedA.jobs.map((j: { id: string }) => j.id), [running.id]);
		assert.deepEqual(feedB.jobs, []);
		const stopJob = await abortRoute.POST(send(B, "POST", { kind: "job", id: running.id }));
		assert.equal(stopJob.status, 404);
		runAsTenant({ id: A, name: A, isAdmin: false }, () => stores.jobStore.updateJob(running.id, { status: "done" }));

		// B's view of A's chat while the turn runs: not found, and the abort touches nothing.
		assert.equal((await chatRoute.GET(get(B), ctx({ id: S.chatA }))).status, 404);
		assert.equal((await chatPost(send(B, "POST", { chatId: S.chatA, input: { type: "text", text: "me too" } }))).status, 404);
		const stopTurn = await abortRoute.POST(send(B, "POST", { kind: "turn", id: S.chatA }));
		assert.equal(stopTurn.status, 409);
		assert.deepEqual(await json(stopTurn), { ok: false, reason: "not_running" });
		assert.ok(runningTurn(S.chatA) !== undefined && isTurnRunning(S.chatA), "A's turn is still running after B's abort");
		assert.equal((await json(await chatRoute.GET(get(A), ctx({ id: S.chatA })))).turnInFlight, true);

		const stopped = await abortRoute.POST(send(A, "POST", { kind: "turn", id: S.chatA }));
		assert.equal(stopped.status, 200);
		await waitFor(() => !isTurnRunning(S.chatA), "A's aborted turn to settle");
	});

	it("after all of it the two file trees share nothing, and shared files live under data/global", () => {
		// The data root holds exactly the per-user tree and the shared one.
		assert.deepEqual(fs.readdirSync(dir).filter((e) => e !== "auth-test.json").sort(), ["global", "users"]);
		assert.ok(fs.readdirSync(path.join(dir, "users")).every((e) => [A, B, ADMIN].includes(e)));
		assert.ok(fs.existsSync(path.join(dir, "global", "admin.json")), "the admin's policy is a shared file");

		const treeA = filesUnder(userRoot(A));
		const treeB = filesUnder(userRoot(B));
		assert.ok(treeA.some((f) => f.includes(`${path.sep}documents${path.sep}`)), "A's document is under A");
		assert.ok(treeA.some((f) => f.includes(`${path.sep}drawings${path.sep}`)), "A's drawing is under A");
		assert.ok(treeA.some((f) => f.includes(`${path.sep}jobs${path.sep}`)), "A's job is under A");

		const scan = (own: string[], foreign: Record<string, string>, owner: string) => {
			for (const file of own) {
				const body = fs.readFileSync(file);
				for (const [label, id] of Object.entries(foreign)) {
					assert.ok(!file.includes(id), `${owner}'s tree has a path naming the other user's ${label}: ${file}`);
					assert.ok(!body.includes(id), `${owner}'s file ${path.relative(dir, file)} holds the other user's ${label}`);
				}
			}
		};
		scan(treeB, { ...S.idsA, userA: A }, "B");
		scan(treeA, { ...S.idsB, userB: B }, "A");

		// B holds exactly what B did: one chat and its derived state, no documents, jobs or drawings.
		for (const dirName of ["documents", "jobs", "drawings"]) {
			assert.deepEqual(treeB.filter((f) => f.includes(`${path.sep}${dirName}${path.sep}`)), [], `B has no ${dirName}`);
		}
		assert.ok(treeB.some((f) => f.includes(S.chatB)), "B's chat is under B");

		// Nothing A produced landed in the shared tree either (only config-like shared files may live there).
		const global = filesUnder(path.join(dir, "global"));
		for (const file of global) {
			const body = fs.readFileSync(file);
			for (const [label, id] of Object.entries(S.idsA)) assert.ok(!body.includes(id) && !file.includes(id), `global file ${path.relative(dir, file)} holds A's ${label}`);
		}
	});

	it("A deletes the document: the concept and the files go with it, B is unaffected", async () => {
		const bTree = filesUnder(userRoot(B));
		const del = await docRoute.DELETE(send(A, "DELETE", {}), ctx({ id: S.docA }));
		assert.equal(del.status, 200);
		assert.equal((await docRoute.GET(get(A), ctx({ id: S.docA }))).status, 404);
		assert.deepEqual((await json(await docsRoute.GET(get(A)))).documents, []);
		assert.equal((await json(await graphRoute.GET(get(A)))).nodes.length, 0, "the document's only concept died with it");
		assert.deepEqual(filesUnder(path.join(userRoot(A), "documents")).filter((f) => f.includes(S.docA)), []);
		assert.deepEqual(filesUnder(userRoot(B)), bTree, "B's files did not change");
	});
});
