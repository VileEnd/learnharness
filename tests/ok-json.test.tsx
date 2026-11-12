import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { okJson } from "../components/ok-json.ts";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { useUsageMonth } from "../components/usage/month-pill.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("okJson", () => {
	it("returns the body of an OK response", async () => {
		assert.deepEqual(await okJson(Response.json({ a: 1 })), { a: 1 });
	});
	it("rejects a non-OK response, whatever its body", async () => {
		await assert.rejects(okJson(Response.json({ error: "no" }, { status: 500 })), /500/);
	});
});

const quietSource = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });

function Probe({ onUsage }: { onUsage: (v: unknown) => void }) {
	onUsage(useUsageMonth());
	return null;
}

describe("a component that parses JSON into state", () => {
	it("useUsageMonth keeps null (not an error body) when /api/usage answers 500", async () => {
		globalThis.fetch = (async () => Response.json({ error: "boom" }, { status: 500 })) as typeof fetch;
		let last: unknown = "unset";
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<ServerEventsProvider connect={quietSource}>
					<Probe onUsage={(v) => { last = v; }} />
				</ServerEventsProvider>,
			);
		});
		await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
		assert.equal(last, null);
		await act(async () => root.unmount());
	});
});
