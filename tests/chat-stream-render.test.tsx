import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import type { ArtifactPartProps, LhMessage } from "../src/core/index.ts";
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
const settledTurn = (n: number): LhMessage[] => [
	{ id: `u${n}`, role: "user", content: `question ${n}`, timestamp: n } as unknown as LhMessage,
	{
		id: `a${n}`, role: "assistant", stopReason: "toolUse", usage, timestamp: n, provider: "openrouter", model: "test",
		content: [{ type: "text", text: `answer ${n}` }, { type: "toolCall", id: `call${n}`, name: "counted", arguments: {} }],
	} as unknown as LhMessage,
	{
		id: `r${n}`, role: "toolResult", toolCallId: `call${n}`, toolName: "counted", isError: false,
		content: [{ type: "text", text: "ok" }], details: { n }, timestamp: n,
	} as unknown as LhMessage,
];

const sse = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const update = (text: string) => ({
	type: "message_update",
	message: { role: "assistant", content: [{ type: "text", text }], usage, provider: "openrouter", model: "test" },
	assistantMessageEvent: { type: "text", textDelta: "" },
});

it("a streamed chunk re-renders only the live tail, not the settled rows", async () => {
	// Render counter: a registered artifact card that counts its own renders per call id.
	const renders = new Map<string, number>();
	const { artifactRenderers } = await import("../components/artifacts/index.ts");
	artifactRenderers.counted = ({ part }: ArtifactPartProps) => {
		const id = String(part.toolCallId);
		renders.set(id, (renders.get(id) ?? 0) + 1);
		return <p>{id}</p>;
	};

	let stream!: ReadableStreamDefaultController<Uint8Array>;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; } }));
		if (url.includes("/api/jobs")) return Response.json([]);
		return Response.json({ providers: [], models: [] });
	}) as typeof fetch;

	const { createRoot } = await import("react-dom/client");
	const { Chat } = await import("../components/chat.tsx");
	const { ServerEventsProvider } = await import("../components/server-events.tsx");
	const quiet = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	// Five settled turns, then the learner's next question, which the streamed answer follows.
	const initialMessages = [...[1, 2, 3, 4, 5].flatMap(settledTurn), settledTurn(6)[0]!];
	await act(async () => {
		root.render(
			<ServerEventsProvider connect={quiet}>
				<Chat chatId="chat_x" title="t" initialMessages={initialMessages} initiallyInFlight />
			</ServerEventsProvider>,
		);
	});
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	const settled = ["call1", "call2", "call3", "call4", "call5"];
	assert.ok(settled.every((id) => (renders.get(id) ?? 0) >= 1), "the settled cards mounted");

	await act(async () => { stream.enqueue(sse({ ...update(""), type: "message_start" })); stream.enqueue(sse(update("par"))); await new Promise((r) => setTimeout(r, 10)); });
	const before = new Map(renders);
	for (const text of ["part", "partial an", "partial answer"]) {
		await act(async () => { stream.enqueue(sse(update(text))); await new Promise((r) => setTimeout(r, 10)); });
	}
	assert.match(host.textContent ?? "", /partial answer/, "the streamed text reached the transcript");
	for (const id of settled) assert.equal(renders.get(id), before.get(id), `${id} re-rendered on a streamed chunk`);
	await act(async () => root.unmount());
});

it("a row whose card throws still shows its inline fallback, in the memoised row", async () => {
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
