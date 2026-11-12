import React, { act, useContext } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import { projectView, type ArtifactPartProps, type JobRecord, type LhMessage } from "../src/core/index.ts";
import { ChatActionsContext } from "../components/chat-actions-context.ts";
import { JobsContext } from "../components/jobs-context.ts";
import type { NotifySource } from "../components/server-events.tsx";

const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(document, { oninput: null, compatMode: "CSS1Compat" }); // KaTeX refuses quirks mode
Object.assign(window, {
	location: { hash: "", pathname: "/chat/chat_x", search: "", href: "http://localhost/chat/chat_x" },
	history: { replaceState() {}, pushState() {} },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(globalThis, {
	window, document,
	Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node,
	HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
	Event: window.Event, CustomEvent: window.CustomEvent,
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
});
Object.assign(window.Element.prototype, { getAnimations: () => [], offsetWidth: 0, clientWidth: 0 });
Object.assign(globalThis, { getComputedStyle: () => ({ getPropertyValue: () => "", paddingTop: "0px", paddingBottom: "0px" }) });
(globalThis as Record<string, unknown>).CSS = { supports: () => true };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const usage = { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 };
/** One settled turn: the learner's question, an answer calling `tool`, and the tool's result. */
const settledTurn = (n: number, tool = "counted", details: unknown = { n }): LhMessage[] => [
	{ id: `u${n}`, role: "user", content: `question ${n}`, timestamp: n } as unknown as LhMessage,
	{
		id: `a${n}`, role: "assistant", stopReason: "toolUse", usage, timestamp: n, provider: "openrouter", model: "test",
		content: [{ type: "text", text: `answer ${n}` }, { type: "toolCall", id: `call${n}`, name: tool, arguments: {} }],
	} as unknown as LhMessage,
	{
		id: `r${n}`, role: "toolResult", toolCallId: `call${n}`, toolName: tool, isError: false,
		content: [{ type: "text", text: "ok" }], details, timestamp: n,
	} as unknown as LhMessage,
];
const closing = (): LhMessage[] => [
	{ id: "u5", role: "user", content: "question 5", timestamp: 5 } as unknown as LhMessage,
	{
		id: "a5", role: "assistant", stopReason: "stop", usage, timestamp: 5, provider: "openrouter", model: "test",
		content: [{ type: "text", text: "closing answer" }],
	} as unknown as LhMessage,
];
/** Four settled turns (turn 4's card reads the jobs and chat-actions contexts), then a closing exchange. */
const transcript = (turn2Details: unknown = { n: 2 }): LhMessage[] => [
	...settledTurn(1),
	...settledTurn(2, "counted", turn2Details),
	...settledTurn(3),
	...settledTurn(4, "counted_ctx"),
	...closing(),
];

const sse = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const update = (text: string) => ({
	type: "message_update",
	message: { role: "assistant", content: [{ type: "text", text }], usage, provider: "openrouter", model: "test" },
	assistantMessageEvent: { type: "text", textDelta: "" },
});
const job = (status: JobRecord["status"]): JobRecord =>
	({ id: "job_1", kind: "research", chatId: "chat_x", toolCallId: "tc_job", status, activity: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }) as JobRecord;

const settle = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

/** A Chat over a scripted server: its stream, jobs list, record and events channel are the test's. */
async function mountChat(initialMessages: LhMessage[], opts: { inFlight?: boolean } = {}) {
	// Render counters: two registered artifact cards counting their own renders per call id.
	// `counted` reads no context; `counted_ctx` reads the two contexts a card can depend on.
	const renders = new Map<string, number>();
	const bump = (part: ArtifactPartProps["part"]) => {
		const id = String(part.toolCallId);
		renders.set(id, (renders.get(id) ?? 0) + 1);
		return id;
	};
	const { artifactRenderers } = await import("../components/artifacts/index.ts");
	artifactRenderers.counted = ({ part }: ArtifactPartProps) => <p>{bump(part)}:{JSON.stringify(part.output)}</p>;
	artifactRenderers.counted_ctx = ({ part }: ArtifactPartProps) => {
		const jobs = useContext(JobsContext);
		useContext(ChatActionsContext);
		return <p>{bump(part)}:jobs={jobs.length}</p>;
	};

	const server = {
		jobs: [] as JobRecord[],
		record: initialMessages,
		stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
		handlers: new Map<string, (data: string) => void>(),
	};
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({ start(c) { server.stream = c; } }));
		if (url.includes("/api/jobs")) return Response.json({ jobs: server.jobs, turnInFlight: false });
		if (url === "/api/chats/chat_x") return Response.json({ messages: server.record });
		return Response.json({ providers: [], models: [] });
	}) as typeof fetch;
	const source = (): NotifySource => ({ close() {}, onOpen() {}, onEvent: (name, cb) => { server.handlers.set(name, cb); } });

	const { createRoot } = await import("react-dom/client");
	const { Chat } = await import("../components/chat.tsx");
	const { ServerEventsProvider } = await import("../components/server-events.tsx");
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<ServerEventsProvider connect={source}>
				<Chat chatId="chat_x" title="t" initialMessages={initialMessages} initiallyInFlight={opts.inFlight} />
			</ServerEventsProvider>,
		);
	});
	await settle();
	return {
		host,
		renders,
		server,
		/** Announce a jobs change on the events channel and let the debounced refetch land. */
		jobsChanged: async () => {
			server.handlers.get("jobs-changed")!(JSON.stringify({ chatId: "chat_x" }));
			await settle(350);
		},
		unmount: () => act(async () => root.unmount()),
	};
}

it("a streamed chunk re-renders only the live tail, not the settled rows", async () => {
	// Five settled turns, then the learner's next question, which the streamed answer follows.
	// Turn 4's card reads the jobs and chat-actions contexts: an unstable context value
	// would re-render it on every chunk.
	const settled = [...settledTurn(1), ...settledTurn(2), ...settledTurn(3), ...settledTurn(4, "counted_ctx"), ...settledTurn(5), settledTurn(6)[0]!];
	const chat = await mountChat(settled, { inFlight: true });
	const ids = ["call1", "call2", "call3", "call4", "call5"];
	assert.ok(ids.every((id) => (chat.renders.get(id) ?? 0) >= 1), "the settled cards mounted");

	const stream = chat.server.stream!;
	await act(async () => { stream.enqueue(sse({ ...update(""), type: "message_start" })); stream.enqueue(sse(update("par"))); await new Promise((r) => setTimeout(r, 10)); });
	const before = new Map(chat.renders);
	for (const text of ["part", "partial an", "partial answer"]) {
		await act(async () => { stream.enqueue(sse(update(text))); await new Promise((r) => setTimeout(r, 10)); });
	}
	assert.match(chat.host.textContent ?? "", /partial answer/, "the streamed text reached the transcript");
	for (const id of ids) assert.equal(chat.renders.get(id), before.get(id), `${id} re-rendered on a streamed chunk`);
	await chat.unmount();
});

it("a settled row re-renders when its own record changes, and its neighbours do not", async () => {
	const chat = await mountChat(transcript());
	chat.server.jobs = [job("running")];
	await chat.jobsChanged(); // the first sight of a running job: nothing owed yet
	const before = new Map(chat.renders);

	// The job settles and its result lands in turn 2's tool result: the idle sync adopts the record.
	chat.server.jobs = [job("done")];
	chat.server.record = transcript({ n: 2, delivered: true });
	await chat.jobsChanged();

	assert.ok(chat.host.textContent?.includes('call2:{"n":2,"delivered":true}'), "the changed result reached turn 2's card");
	assert.ok(chat.renders.get("call2")! > before.get("call2")!, "turn 2 re-rendered");
	for (const id of ["call1", "call3"]) assert.equal(chat.renders.get(id), before.get(id), `${id} re-rendered though its record did not change`);
	await chat.unmount();
});

it("a settled card re-renders when a context it reads changes; one that reads none does not", async () => {
	const chat = await mountChat(transcript());
	assert.ok(chat.host.textContent?.includes("call4:jobs=0"));
	const before = new Map(chat.renders);

	chat.server.jobs = [job("running")];
	await chat.jobsChanged();

	assert.ok(chat.host.textContent?.includes("call4:jobs=1"), "the card shows the new jobs list");
	assert.ok(chat.renders.get("call4")! > before.get("call4")!, "the context consumer re-rendered");
	for (const id of ["call1", "call2", "call3"]) assert.equal(chat.renders.get(id), before.get(id), `${id} reads no context and must not re-render`);
	await chat.unmount();
});

it("the live row re-renders when the stream ends and its streaming state flips", async () => {
	const chat = await mountChat([...settledTurn(1), settledTurn(2)[0]!], { inFlight: true });
	const stream = chat.server.stream!;
	const thinking = { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], usage, provider: "openrouter", model: "test" }, assistantMessageEvent: { type: "thinking", delta: "" } };
	await act(async () => { stream.enqueue(sse({ ...thinking, type: "message_start" })); stream.enqueue(sse(thinking)); await new Promise((r) => setTimeout(r, 10)); });
	assert.ok(chat.host.textContent?.includes("Thinking..."), "the live reasoning row shows its streaming state");

	await act(async () => { stream.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); stream.close(); await new Promise((r) => setTimeout(r, 20)); });
	assert.ok(!chat.host.textContent?.includes("Thinking..."), "the former live row left its streaming state");
	assert.ok(chat.host.textContent?.includes("AGENT’S THINKING"));
	await chat.unmount();
});

it("a row re-renders exactly once when only streamingTail flips", async () => {
	const { TranscriptRow } = await import("../components/chat.tsx");
	const { createRoot } = await import("react-dom/client");
	const { artifactRenderers } = await import("../components/artifacts/index.ts");
	let renders = 0;
	artifactRenderers.counted = () => { renders++; return <p>card</p>; };
	const m = projectView(settledTurn(1)).find((v) => v.role === "assistant")!;
	const sourceTextParts = new Map<string, string>();
	const onOpenPlan = () => {};
	const row = (streamingTail: boolean) => (
		<TranscriptRow m={m} phase="probe" prevPhase="probe" streamingTail={streamingTail} sourceTextParts={sourceTextParts} chatId="chat_x" onOpenPlan={onOpenPlan} />
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => { root.render(row(false)); });
	assert.equal(renders, 1);
	await act(async () => { root.render(row(false)); });
	assert.equal(renders, 1, "equal props: the memo skips the row");
	await act(async () => { root.render(row(true)); });
	assert.equal(renders, 2, "the flip re-renders the row once");
	await act(async () => { root.render(row(true)); });
	assert.equal(renders, 2);
	await act(async () => { root.render(row(false)); });
	assert.equal(renders, 3, "and once back");
	await act(async () => root.unmount());
});

it("a row whose card throws still shows its inline fallback, in the memoised row", async () => {
	const chat = await mountChat([]); // registers the cards; the throwing one replaces `counted` below
	await chat.unmount();
	const { artifactRenderers } = await import("../components/artifacts/index.ts");
	artifactRenderers.counted = () => {
		throw new Error("card logic");
	};
	globalThis.fetch = (async (input: RequestInfo | URL) =>
		String(input).includes("/api/jobs") ? Response.json([]) : Response.json({ providers: [], models: [] })) as typeof fetch;
	const { createRoot } = await import("react-dom/client");
	const { Chat } = await import("../components/chat.tsx");
	const { ServerEventsProvider } = await import("../components/server-events.tsx");
	const quiet = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const realError = console.error;
	console.error = () => {}; // React and the boundary both log the caught throw
	try {
		await act(async () => {
			root.render(
				<ServerEventsProvider connect={quiet}>
					<Chat chatId="chat_x" title="t" initialMessages={[...settledTurn(1), ...settledTurn(2).slice(0, 1)]} />
				</ServerEventsProvider>,
			);
		});
	} finally {
		console.error = realError;
	}
	assert.equal(host.querySelectorAll('[data-testid="part-error"]').length, 1);
	assert.match(host.textContent ?? "", /answer 1/, "the rest of the row still renders");
	assert.match(host.textContent ?? "", /question 2/, "the next row still renders");
	await act(async () => root.unmount());
});
