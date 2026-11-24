import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { usePlanLayout } from "../components/plan-block.tsx";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { NODE_W_MIN, PAD_X } from "../components/plan-layout.ts";

// Plan boxes are sized from the labels measured in the real font after
// mount (usePlanLayout), and a reading-font change or a completed font
// load measures them again. The probe's SVG text is stubbed: each
// character is `advance` px wide in "the font on screen".

const TITLE = "Orthogonal diagonalisation";
const plan = { nodes: [{ id: "a", title: TITLE }], edges: [] };

it("boxes take the measured label width, and a font change or font load re-measures", async () => {
	const dom = parseHTML("<!doctype html><html><body></body></html>");
	const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
	Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
	Object.defineProperty(dom.document, "fonts", { value: fonts });
	Object.defineProperty(dom.document, "createRange", { value: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }) });
	const saved = Object.fromEntries(["window", "document", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.document,
		IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ fontSize: "11px" }),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
	});
	const { createRoot } = await import("react-dom/client");
	let advance = 10;
	let setFont: ((fontFamily: string) => void) | undefined;
	function Harness() {
		const { layout, probe } = usePlanLayout(plan);
		const { onAppearanceChange } = useAppearance();
		setFont = (fontFamily) => onAppearanceChange({ fontFamily });
		const stub = (el: SVGTextElement | null, ref: { current: SVGTextElement | null }) => {
			ref.current = el;
			if (el) el.getComputedTextLength = () => (el.textContent?.length ?? 0) * advance;
		};
		return (
			<div data-width={layout.nodeW.get("a")}>
				<svg>
					<text ref={(el) => stub(el, probe.sentinel)}>sample</text>
					<text ref={(el) => stub(el, probe.measurer)} />
				</svg>
				<div ref={probe.breaker} />
			</div>
		);
	}
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host);
	const width = () => Number(host.querySelector("[data-width]")!.getAttribute("data-width"));
	try {
		await act(async () => {
			root.render(
				<AppearanceProvider initialAppearance={undefined}>
					<Harness />
				</AppearanceProvider>,
			);
		});
		// The chart (Source Sans estimate) would give a much narrower box.
		assert.equal(width(), TITLE.length * 10 + 2 * PAD_X, "the box hugs the measured line");
		assert.ok(width() > NODE_W_MIN);

		advance = 12; // the reading font changes: wider glyphs
		await act(async () => setFont!("JetBrains Mono"));
		assert.equal(width(), TITLE.length * 12 + 2 * PAD_X, "a font pick re-measures");

		advance = 8; // a web font finishes loading under the same setting
		await act(async () => { fonts.dispatchEvent(new Event("loadingdone")); });
		assert.equal(width(), TITLE.length * 8 + 2 * PAD_X, "a completed font load re-measures");
	} finally {
		await act(async () => root.unmount());
		for (const [k, d] of Object.entries(saved)) {
			if (d) Object.defineProperty(globalThis, k, d);
			else Reflect.deleteProperty(globalThis, k);
		}
	}
});
