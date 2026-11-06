import React, { act, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { ChatSessionComposer } from "../components/composer.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { appendToClaimedTarget, joinDictation } from "../components/dictation.tsx";

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(document, { oninput: null }); // React feature-detects input events via "oninput" in document
Object.assign(window, {
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(globalThis, {
	window,
	document,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLTextAreaElement: window.HTMLTextAreaElement,
	Event: window.Event,
	CustomEvent: window.CustomEvent,
});

(globalThis as Record<string, unknown>).CSS = { supports: () => true };

const roots: { root: Root; host: HTMLElement }[] = [];

async function mount(element: React.ReactElement) {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

/** Type like a browser: the native setter bypasses React's value tracker. */
async function typeText(field: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
	await act(async () => {
		setter.call(field, value);
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

function fieldIn(host: HTMLElement): HTMLTextAreaElement {
	const field = host.querySelector("textarea");
	assert.ok(field);
	return field as unknown as HTMLTextAreaElement;
}

const submit = (host: HTMLElement) =>
	act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
const sendButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]');

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
});

describe("session text fields keep keystrokes local", () => {
	it("typing does not re-render the owner; explicit resets reach the textarea", async () => {
		let parentRenders = 0;
		let latest = "";
		let reset!: (value: string) => void;
		function Parent() {
			parentRenders++;
			const [external, setExternal] = useState({ value: "", revision: 0 });
			reset = (value) => setExternal((p) => ({ value, revision: p.revision + 1 }));
			return (
				<ChatSessionComposer
					busy={false}
					value={external.value}
					revision={external.revision}
					onChange={(value) => { latest = value; }}
					onSend={() => {}}
					onStop={() => {}}
					sendAllowed
					dictationActive={false}
				/>
			);
		}
		const host = await mount(<Parent />);
		const field = fieldIn(host);
		assert.equal(sendButton(host)?.disabled, true);
		await typeText(field, "h");
		await typeText(field, "hello");
		assert.equal(field.value, "hello");
		assert.equal(latest, "hello");
		assert.equal(parentRenders, 1, "keystrokes never render the owner");
		assert.equal(sendButton(host)?.disabled, false, "the send affordance follows local text");

		await act(async () => { reset("restored draft"); });
		assert.equal(field.value, "restored draft");
		assert.equal(parentRenders, 2);
	});

	it("keeps local edits across unrelated owner renders; send, restore and append keep exact text", async () => {
		let refresh!: () => void;
		let applyText!: (value: string) => void;
		let current!: () => string;
		const sent: string[] = [];
		function Parent() {
			const ref = useRef("");
			const [revision, setRevision] = useState(0);
			const [, setTick] = useState(0);
			refresh = () => setTick((t) => t + 1);
			current = () => ref.current;
			// Mirrors Chat: textRef is the synchronous truth, applyText bumps the revision.
			applyText = (v) => { ref.current = v; setRevision((r) => r + 1); };
			return (
				<ChatSessionComposer
					busy={false}
					value={ref.current}
					revision={revision}
					onChange={(v) => { ref.current = v; }}
					onSend={() => { sent.push(ref.current.trim()); applyText(""); }}
					onStop={() => {}}
					sendAllowed
					dictationActive={false}
				/>
			);
		}
		const host = await mount(<Parent />);
		const field = fieldIn(host);
		await typeText(field, "typed");
		await act(async () => { refresh(); });
		assert.equal(field.value, "typed", "an unrelated owner render keeps the local text");

		// Two dictation appends back to back, joined against the ref (as Chat does).
		await act(async () => {
			applyText(joinDictation(current(), "one"));
			applyText(joinDictation(current(), "two"));
		});
		assert.equal(field.value, "typed one two");

		await submit(host);
		assert.deepEqual(sent, ["typed one two"]);
		assert.equal(field.value, "");
		assert.equal(sendButton(host)?.disabled, true);

		// A refused send restores the draft even though the seed was already empty.
		await typeText(field, "unsent");
		await act(async () => { applyText("restored after refusal"); });
		assert.equal(field.value, "restored after refusal");
		await typeText(field, "newer edit");
		await act(async () => { applyText("restored after refusal"); });
		assert.equal(field.value, "restored after refusal", "same-value restore still resets (revision)");
	});

	it("send gate, dictation and Next affordances behave as before", async () => {
		let update!: (patch: Record<string, unknown>) => void;
		let sends = 0;
		let nexts = 0;
		let state: Record<string, unknown> = { busy: false, sendAllowed: true, dictationActive: false, nextProblem: true };
		function Parent() {
			const [s, setS] = useState(state);
			update = (patch) => { state = { ...state, ...patch }; setS(state); };
			return (
				<ChatSessionComposer
					busy={s.busy as boolean}
					sendAllowed={s.sendAllowed as boolean}
					dictationActive={s.dictationActive as boolean}
					nextProblem={s.nextProblem as boolean}
					value=""
					revision={0}
					onChange={() => {}}
					onSend={() => { sends++; }}
					onStop={() => {}}
					onNext={() => { nexts++; }}
				/>
			);
		}
		const host = await mount(<Parent />);
		await submit(host);
		assert.equal(nexts, 1);
		await act(async () => { update({ dictationActive: true, nextProblem: false }); });
		assert.equal(sendButton(host)?.disabled, false, "dictation alone enables send");
		await submit(host);
		assert.equal(sends, 1);
		await act(async () => { update({ dictationActive: false }); });
		await typeText(fieldIn(host), "steer");
		await act(async () => { update({ sendAllowed: false }); });
		assert.equal(sendButton(host)?.disabled, true);
		await submit(host);
		assert.equal(sends, 1, "a closed gate wins over local text");
	});

	it("reading thoughts type locally, forward drafts and honour explicit resets", async () => {
		let parentRenders = 0;
		let latest = "";
		let reset!: (value: string) => void;
		let refresh!: () => void;
		function Parent() {
			parentRenders++;
			const [seed, setSeed] = useState({ value: "", revision: 0 });
			const [, setTick] = useState(0);
			refresh = () => setTick((t) => t + 1);
			reset = (value) => { latest = value; setSeed((p) => ({ value, revision: p.revision + 1 })); };
			return <ReadingThinkingField {...seed} onChange={(v) => { latest = v; }} claim={false} />;
		}
		const host = await mount(<Parent />);
		const field = fieldIn(host);
		await typeText(field, "thinking while reading");
		assert.equal(latest, "thinking while reading");
		assert.equal(parentRenders, 1, "typing does not render the owner");
		await act(async () => { refresh(); });
		assert.equal(field.value, "thinking while reading");
		await act(async () => { reset("saved"); });
		await typeText(field, "edited");
		await act(async () => { reset("saved"); });
		assert.equal(field.value, "saved");
		assert.equal(latest, "saved");
	});

	it("consecutive reading appends before a commit drop nothing", async () => {
		let latest = "";
		let forwarded = 0;
		const host = await mount(
			<ReadingThinkingField value="" revision={0} claim onChange={(v) => { latest = v; forwarded++; }} />,
		);
		const field = fieldIn(host);
		await typeText(field, "typed thoughts");
		forwarded = 0;
		await act(async () => {
			assert.equal(appendToClaimedTarget("spoken tail"), true);
			assert.equal(latest, "typed thoughts spoken tail", "the tail is visible synchronously");
			assert.equal(appendToClaimedTarget("more"), true);
			assert.equal(latest, "typed thoughts spoken tail more");
		});
		assert.equal(field.value, "typed thoughts spoken tail more");
		assert.equal(forwarded, 2);
	});
});
