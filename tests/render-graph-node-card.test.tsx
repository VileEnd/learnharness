/**
 * The graph's concept card (components/graph-node-card.tsx) renders its name
 * and statement as Markdown with math, through the same sanitised path as
 * other model text, keeping the card's own type; its placement re-measures
 * when the rendered content grows.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mountSettled } from "./mount-rendered.tsx";
import { NodeCardBody, observeNodeCardPosition } from "../components/graph-node-card.tsx";
import type { GraphNode } from "../src/core/contracts.ts";

const node = (name: string, statement: string) =>
	({ id: "n1", name, statement, aliases: [], state: "new", createdAt: "2026-09-20T10:00:00.000Z", provenance: [] }) as unknown as GraphNode;
const card = (name: string, statement: string) => <NodeCardBody node={node(name, statement)} sourceIds={[]} sessions={{}} fileSources={{}} documents={undefined} />;
const formulas = (host: ParentNode) => host.querySelectorAll(".katex").length;
/** Mount, wait for the on-demand renderer, hand the DOM to `check`. */
async function shown(name: string, statement: string, check: (host: HTMLElement) => void): Promise<void> {
	const { host, unmount } = await mountSettled(card(name, statement), (h) => h.querySelectorAll(".lh-prose").length === 2);
	try { check(host); } finally { await unmount(); }
}

describe("node detail card text", () => {
	it("renders math in the name and in the statement", async () => {
		await shown(String.raw`Euler's formula $e^{ix}$`, String.raw`For real $x$, $e^{ix}=\cos x+i\sin x$.`, (host) => {
			assert.equal(formulas(host), 3);
			assert.ok(host.textContent!.includes("For real"), "the surrounding prose survives");
			assert.ok(![...host.querySelectorAll(".lh-prose")].some((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.includes("$"))), "no raw dollar delimiters remain");
		});
	});

	it("keeps the TeX source in the markup for assistive technology", async () => {
		await shown("Name", String.raw`Uses $\sqrt{x}$.`, (host) => {
			assert.deepEqual([...host.querySelectorAll('annotation[encoding="application/x-tex"]')].map((a) => a.textContent), [String.raw`\sqrt{x}`]);
			assert.ok(host.querySelector("math"), "MathML carries the readable statement");
		});
	});

	it("renders a display block in the statement as display math, without a copy icon", async () => {
		await shown("Gaussian integral", "Over the real line:\n\n$$\n" + String.raw`\int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt{\pi}` + "\n$$", (host) => {
			assert.equal(formulas(host), 1);
			assert.ok(host.querySelector(".katex-display"));
			assert.equal(host.querySelectorAll('[data-testid="md-copy"], [aria-label^="Copy"]').length, 0);
		});
	});

	it("leaves plain text as plain text", async () => {
		const statement = "The maximum ratio of broad money a bank can create from each unit of base money.";
		await shown("Money multiplier", statement, (host) => {
			assert.equal(formulas(host), 0);
			assert.ok(host.textContent!.includes("Money multiplier") && host.textContent!.includes(statement));
		});
	});

	it("uses the shared Markdown and image-safety policy: no markup injection, no remote image", async () => {
		await shown("**Meaning** $x$ <img src=x onerror=alert(1)>",
			'A [reference](https://example.invalid/) and `literal` code.<script>alert(1)</script>\n\n![untrusted](https://example.invalid/image.png)', (host) => {
			assert.equal(host.querySelector("strong")?.textContent, "Meaning");
			assert.equal(host.querySelector('[data-streamdown="inline-code"]')?.textContent, "literal");
			assert.equal(host.querySelector("img"), null, "node content cannot load a remote image");
			assert.equal(host.querySelectorAll("script, [onerror]").length, 0);
			assert.ok([...host.querySelectorAll('[data-streamdown="link"]')].some((link) => link.textContent === "untrusted"), "a remote image becomes a link the learner can open");
		});
	});

	it("keeps the card's own type, and scrolls a wide formula inside its own block", async () => {
		await shown("Name `x`", "Statement `x`", (host) => {
			const lines = [...host.querySelectorAll(".lh-prose")];
			assert.equal(lines.length, 2);
			for (const line of lines) {
				assert.ok(line.classList.contains("[--font-prose:var(--font-ui)]"));
				assert.ok(line.classList.contains("[&_[data-streamdown=inline-code]]:[font-size:inherit]"));
				assert.ok(line.classList.contains("[&_[data-streamdown=inline-code]]:[color:inherit]"));
				for (const css of ["min-w-0", "max-w-full", "overflow-x-auto", "[&_.katex-base]:my-0.5"]) assert.ok(line.classList.contains(css), css);
			}
			assert.ok(lines[0]!.classList.contains("font-medium") && lines[0]!.classList.contains("[--lh-prose-size:var(--text-sm)]"));
			assert.ok(lines[1]!.classList.contains("text-muted-foreground") && lines[1]!.classList.contains("[--lh-prose-size:var(--text-xs)]"));
		});
	});
});

describe("node detail card placement", () => {
	it("remeasures late content and container changes, then disconnects on cleanup", () => {
		const previous = globalThis.ResizeObserver;
		const observed: Element[] = [];
		let notify: () => void = () => { throw new Error("observer not created"); };
		let disconnected = false;
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) { notify = callback; }
			observe(element: Element) { observed.push(element); }
			disconnect() { disconnected = true; }
		} as unknown as typeof ResizeObserver;
		try {
			const card = { offsetWidth: 320, offsetHeight: 164, style: { left: "", top: "", visibility: "hidden" } };
			const container = { clientWidth: 600, clientHeight: 560 };
			const cleanup = observeNodeCardPosition(card as HTMLDivElement, container as HTMLElement, { x: 300, y: 500 });
			assert.deepEqual(observed, [card, container]);
			assert.deepEqual(card.style, { left: "140px", top: "324px", visibility: "visible" });
			// Math or a table can finish laying out after the layout effect: keep
			// the 12px node gap instead of leaving the card's bottom off-screen.
			card.offsetHeight = 308;
			notify();
			assert.equal(card.style.top, "180px");
			container.clientWidth = 360;
			notify();
			assert.equal(card.style.left, "32px", "container resize keeps the horizontal clamp");
			container.clientHeight = 900;
			notify();
			assert.equal(card.style.top, "512px", "a taller container has room below the node again");
			cleanup();
			assert.equal(disconnected, true);
		} finally {
			if (previous === undefined) Reflect.deleteProperty(globalThis, "ResizeObserver");
			else globalThis.ResizeObserver = previous;
		}
	});

	it("keeps the below-node placement and edge clamps without an observer", () => {
		const previous = globalThis.ResizeObserver;
		Reflect.deleteProperty(globalThis, "ResizeObserver");
		try {
			const card = { offsetWidth: 320, offsetHeight: 100, style: { left: "", top: "", visibility: "hidden" } };
			const container = { clientWidth: 600, clientHeight: 560 };
			observeNodeCardPosition(card as HTMLDivElement, container as HTMLElement, { x: 10, y: 30 })();
			assert.deepEqual(card.style, { left: "8px", top: "42px", visibility: "visible" });
			card.offsetHeight = 700;
			observeNodeCardPosition(card as HTMLDivElement, container as HTMLElement, { x: 590, y: 500 })();
			assert.equal(card.style.left, "272px");
			assert.equal(card.style.top, "8px", "oversized content keeps the top-margin clamp");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(globalThis, "ResizeObserver");
			else globalThis.ResizeObserver = previous;
		}
	});
});
