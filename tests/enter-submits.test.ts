/**
 * enter-submits + focus-hygiene — the pointer/keyboard Enter split and the
 * transient-control blur (owner, keyboard round 2026-10-10).
 *
 * The regression this pins: clicking a transcript control (a thinking
 * toggle) left focus on its <button>; the learner's next Enter re-activated
 * the toggle instead of submitting. The law now: Enter from a
 * POINTER-focused transcript button submits (the window listener also
 * preventDefaults, suppressing the default activation underneath);
 * keyboard-focused buttons and buttons inside open overlays (menus walk
 * focus with arrows, dialogs are their own layer) keep native Enter.
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { describe, it } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { buttonKeepsNativeEnter, useEnterSubmits } from "../components/enter-submits.ts";
import { blurAfterPointerClick } from "../components/focus-hygiene.ts";

const { document } = parseHTML("<html><body></body></html>");

function buttonIn(attrs: Record<string, string>): HTMLElement {
	const host = document.createElement("div");
	for (const [k, v] of Object.entries(attrs)) host.setAttribute(k, v);
	const b = document.createElement("button");
	b.type = "button";
	host.appendChild(b);
	document.body.appendChild(host);
	return b;
}

describe("buttonKeepsNativeEnter (the pointer/keyboard Enter split)", () => {
	it("a transcript button (pointer-focused) does NOT keep native Enter — Enter submits", () => {
		const b = buttonIn({});
		assert.equal(buttonKeepsNativeEnter(b), false);
	});

	it("a keyboard-focused button keeps native Enter (:focus-visible)", () => {
		const b = buttonIn({});
		// linkedom lacks the pseudo — stub the one call the helper makes.
		(b as unknown as { matches: (sel: string) => boolean }).matches = (sel: string) =>
			sel === ":focus-visible";
		assert.equal(buttonKeepsNativeEnter(b), true);
	});

	it("buttons inside overlays keep native Enter: hand-rolled menu, Radix popper, dialog, menu role", () => {
		assert.equal(buttonKeepsNativeEnter(buttonIn({ "data-lh-menu": "" })), true);
		assert.equal(
			buttonKeepsNativeEnter(buttonIn({ "data-radix-popper-content-wrapper": "" })),
			true,
		);
		assert.equal(buttonKeepsNativeEnter(buttonIn({ role: "dialog" })), true);
		assert.equal(buttonKeepsNativeEnter(buttonIn({ role: "menu" })), true);
	});

	it("a selector engine without :focus-visible degrades to pointer-focus, never throws", () => {
		const b = buttonIn({});
		assert.doesNotThrow(() => buttonKeepsNativeEnter(b));
		assert.equal(buttonKeepsNativeEnter(b), false);
	});
});

describe("blurAfterPointerClick (focus hygiene)", () => {
	it("a POINTER click (detail > 0) blurs the transient control", () => {
		const b = buttonIn({});
		let blurred = false;
		b.blur = () => {
			blurred = true;
		};
		blurAfterPointerClick({ detail: 1, currentTarget: b });
		assert.equal(blurred, true);
	});

	it("a KEYBOARD-activated click (detail 0) keeps focus", () => {
		const b = buttonIn({});
		let blurred = false;
		b.blur = () => {
			blurred = true;
		};
		blurAfterPointerClick({ detail: 0, currentTarget: b });
		assert.equal(blurred, false);
	});
});

/** The hook itself, on the probe card's <summary>: it follows the button rule
 *  (keyboard-focused keeps native Enter and does not submit; pointer-focused
 *  does not keep it, so Enter submits and the toggle does not fire). */
describe("useEnterSubmits and a <summary> (the probe card's disclosure)", () => {
	async function pressEnterOn(configure: (summary: HTMLElement) => void): Promise<{ submitted: number; prevented: boolean }> {
		const dom = parseHTML("<html><body></body></html>");
		const globals = { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
		const previous = Object.getOwnPropertyDescriptors(globalThis);
		Object.assign(globalThis, globals);
		let submitted = 0;
		function Probe() {
			useEnterSubmits(() => { submitted++; });
			return React.createElement("details", null, React.createElement("summary", { "data-testid": "s" }, "Probe assessment"), React.createElement("p", null, "body"));
		}
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () => root.render(React.createElement(Probe)));
			const summary = host.querySelector("summary") as HTMLElement;
			configure(summary);
			const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
			summary.dispatchEvent(event);
			return { submitted, prevented: event.defaultPrevented };
		} finally {
			await act(async () => root.unmount());
			for (const key of Object.keys(globals)) {
				if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	}

	it("a keyboard-focused summary keeps its native Enter: no submit, no preventDefault", async () => {
		const out = await pressEnterOn((s) => {
			(s as unknown as { matches: (sel: string) => boolean }).matches = (sel) => sel === ":focus-visible";
		});
		assert.deepEqual(out, { submitted: 0, prevented: false });
	});

	it("a pointer-focused summary does not: Enter submits, exactly as for a button", async () => {
		const out = await pressEnterOn(() => {});
		assert.deepEqual(out, { submitted: 1, prevented: true });
	});
});
