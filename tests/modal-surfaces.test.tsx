import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, byId, dom, mount, press, rerender, unmount } from "./helpers/modal-dom.tsx";
import { AbortTurnDialog } from "../components/abort-turn-dialog.tsx";
import { DeleteSessionDialog } from "../components/delete-session-dialog.tsx";
import { DeleteNodeDialog } from "../components/delete-node-dialog.tsx";
import { DeleteDocumentDialog } from "../components/delete-document-dialog.tsx";
import { AddDocumentsDialog } from "../components/add-documents-dialog.tsx";
import { SettingsDialogProvider, useSettingsDialog } from "../components/settings/settings-dialog.tsx";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { MermaidOverlay } from "../components/session-overlay.tsx";
import { PlanPopup } from "../components/plan-block.tsx";
import { SessionWatch } from "../components/session-watch.tsx";
import React from "react";
import { useModal } from "../components/ui/use-modal.ts";
import { blurAfterPointerClick } from "../components/focus-hygiene.ts";
import { QuestionDock } from "../components/question-dock.tsx";
import { CanvasWorkspace } from "../components/canvas/canvas-workspace.tsx";

// Wiring only: each surface moves focus in, makes the rest inert, keeps Tab
// inside and gives focus back. The behaviour itself is tests/use-modal.test.tsx.

const mediaQuery = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(dom.window, {
	history: { state: null, pushState() {}, back() {} },
	matchMedia: mediaQuery,
	// SessionWatch wraps window.fetch and reads location.origin.
	fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
	location: { origin: "http://localhost", href: "http://localhost/", pathname: "/" },
});
Object.assign(globalThis, { location: dom.window.location });
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) },
});
// The canvas engine draws on 2D contexts and probes CSS support: no-op stand-ins.
Object.assign(globalThis, { MutationObserver: class { observe() {} disconnect() {} } });
Object.assign(globalThis, { getComputedStyle: () => ({ getPropertyValue: () => "" }) });
Object.assign(globalThis, { CSS: { supports: () => false, escape: (s: string) => s } });
(dom.window.HTMLCanvasElement.prototype as { getContext: unknown }).getContext = () =>
	new Proxy({}, { get: () => () => ({ width: 0 }), set: () => true });
Object.assign(globalThis, { matchMedia: mediaQuery });

const realFetch = globalThis.fetch;
beforeEach(() => {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const path = new URL(String(input), "http://localhost").pathname;
		if (path === "/api/settings") return Response.json({ settings: null });
		if (path === "/api/me") return Response.json({ account: null });
		if (path === "/api/keys") return Response.json({ providers: [], keys: [] });
		if (path === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
		if (path.includes("/drawings/")) return new Response("{}", { status: 404 });
		return Response.json({});
	}) as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	await unmount();
});

const noop = () => {};

/** A minimal registered modal surface that takes focus itself (a root-focus surface). */
function RootModal() {
	const ref = React.useRef<HTMLDivElement>(null);
	useModal(ref);
	return <div ref={ref} data-testid="root-modal" data-autofocus role="dialog" aria-modal="true" />;
}
const testId = () => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "";

/** The app: an opener, a scroller and the slot the surface mounts into. */
function App({ inline, portal }: { inline?: React.ReactNode; portal?: React.ReactNode }) {
	return (
		<>
			<main id="page"><button id="opener" type="button">open</button></main>
			<section id="area"><div id="scroller"><textarea id="composer" /></div>{inline}</section>
			{portal}
		</>
	);
}

type Kind = "portal" | "inline";
/** Open `surface`, then check the four behaviours against `rootTestId`. */
async function checkSurface(kind: Kind, surface: () => React.ReactNode, rootTestId: string, focusTestId: string) {
	const withSurface = (on: boolean) => (kind === "portal" ? <App portal={on ? surface() : null} /> : <App inline={on ? surface() : null} />);
	await mount(withSurface(false));
	byId("opener").focus();
	await rerender(withSurface(true));
	const root = document.querySelector<HTMLElement>(`[data-testid="${rootTestId}"]`);
	assert.ok(root, `${rootTestId} is open`);
	assert.equal(testId(), focusTestId, "focus moved to the right control");
	if (kind === "portal") assert.ok(byId("app").hasAttribute("inert"), "the app is inert");
	else {
		assert.ok(byId("scroller").hasAttribute("inert"), "the rest of the session area is inert");
		assert.ok(!byId("page").hasAttribute("inert") && !byId("area").hasAttribute("inert"), "the sidebar / top bar stay live");
	}
	if (focusTestId === rootTestId) assert.equal(root.getAttribute("tabindex"), "-1", "a root takes focus only through tabindex");
	const e = press(document.activeElement!, "Tab");
	assert.ok(e.defaultPrevented && root.contains(document.activeElement), "Tab stays inside");
	press(document.activeElement!, "Tab", { shiftKey: true });
	assert.ok(root.contains(document.activeElement), "Shift+Tab stays inside");
	await rerender(withSurface(false));
	assert.equal(document.querySelectorAll("[inert]").length, 0, "inert is gone after close");
	assert.equal(document.activeElement?.id, "opener", "focus is back on the opener");
}

describe("modal surfaces are wired to the shared behaviour", () => {
	it("abort-turn confirm: lands on Cancel", async () => {
		await checkSurface("portal", () => <AbortTurnDialog mode="turn" onClose={noop} onConfirm={noop} />, "abort-turn-dialog", "abort-turn-cancel");
	});
	it("delete session: lands on Cancel", async () => {
		await checkSurface("portal", () => <DeleteSessionDialog chat={{ id: "c1", title: "A chat" }} onClose={noop} onDeleted={noop} />, "delete-session-dialog", "delete-cancel");
	});
	it("delete node: lands on Cancel", async () => {
		await checkSurface("portal", () => <DeleteNodeDialog nodes={[{ id: "n1", name: "Node" }]} onClose={noop} onDeleted={noop} />, "delete-node-dialog", "node-delete-cancel");
	});
	it("delete document: lands on Cancel", async () => {
		await checkSurface(
			"portal",
			() => <DeleteDocumentDialog docId="d1" title="Doc" removal={{ concepts: 1, shared: 0 }} open onClose={noop} onDeleted={noop} />,
			"delete-document-dialog",
			"delete-document-cancel",
		);
	});
	it("add documents: lands on Close", async () => {
		await checkSurface("portal", () => <AddDocumentsDialog open onClose={noop} onImported={noop} />, "add-documents-dialog", "add-documents-close");
	});
	it("a portalled dialog makes the sidebar (everything outside it) inert, unlike the in-session overlays", async () => {
		await mount(<App portal={<AbortTurnDialog mode="turn" onClose={noop} onConfirm={noop} />} />);
		assert.ok(byId("app").hasAttribute("inert"));
	});
	it("setup: lands on the dialog (its Close button is a tooltip trigger)", async () => {
		await checkSurface("portal", () => <SetupDialog open onClose={noop} onDone={noop} />, "setup-dialog", "setup-dialog");
	});
	it("signed out: lands on Sign in again", async () => {
		// The watch wraps window.fetch (the same slot as globalThis.fetch under
		// linkedom): a 401 from our own API flips it to the signed-out screen.
		globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
		await mount(<App portal={<SessionWatch />} />);
		byId("opener").focus();
		await act(async () => {
			await window.fetch("/api/anything");
		});
		const root = document.querySelector<HTMLElement>('[data-testid="session-expired"]');
		assert.ok(root);
		assert.equal(root.getAttribute("aria-modal"), "true");
		assert.equal(document.activeElement?.tagName, "BUTTON");
		assert.ok(root.contains(document.activeElement));
		assert.ok(byId("page").hasAttribute("inert") && byId("area").hasAttribute("inert"));
	});
	it("diagram focus overlay: lands on the overlay", async () => {
		await checkSurface("inline", () => <MermaidOverlay svg='<svg viewBox="0 0 10 10"></svg>' onClose={noop} />, "mermaid-overlay", "mermaid-overlay");
	});
	it("plan popup: lands on the popup", async () => {
		await checkSurface("inline", () => <PlanPopup messages={[]} onClose={noop} />, "plan-popup", "plan-popup");
	});
	it("canvas workspace: lands on the workspace", async () => {
		await checkSurface(
			"inline",
			() => <CanvasWorkspace chatId="c1" callId="k1" question="Draw it" onSubmit={noop} onMinimize={noop} />,
			"canvas-workspace",
			"canvas-workspace",
		);
	});
	it("settings: lands on the dialog, inert behind, focus back on the button that opened it", async () => {
		function Opener() {
			const { open } = useSettingsDialog();
			return <button id="opener" type="button" onClick={() => open()}>open</button>;
		}
		await mount(<SettingsDialogProvider><Opener /></SettingsDialogProvider>);
		byId("opener").focus();
		await act(async () => void byId("opener").dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(testId(), "settings-dialog");
		assert.ok(byId("app").hasAttribute("inert"));
		press(document.activeElement!, "Escape");
		await act(async () => {});
		assert.equal(document.querySelector('[data-testid="settings-dialog"]'), null, "Esc still closes it");
		assert.equal(document.activeElement?.id, "opener");
		assert.equal(document.querySelectorAll("[inert]").length, 0);
	});
});

/** A fetch that never answers: the action stays "running". */
function hang() {
	globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
}
async function click(el: Element) {
	await act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
}

describe("Escape is ignored while the dialog's own action runs", () => {
	it("delete node (multi-node delete)", async () => {
		let closed = 0;
		await mount(<DeleteNodeDialog nodes={[{ id: "a", name: "A" }, { id: "b", name: "B" }]} onClose={() => closed++} onDeleted={noop} />);
		hang();
		await click(document.querySelector('[data-testid="node-delete-confirm"]')!);
		const e = press(document.body, "Escape");
		assert.equal(closed, 0);
		assert.ok(e.defaultPrevented, "still claimed, so it cannot chain into an abort");
	});
	it("delete session", async () => {
		let closed = 0;
		await mount(<DeleteSessionDialog chat={{ id: "c", title: "T" }} onClose={() => closed++} onDeleted={noop} />);
		hang();
		await click(document.querySelector('[data-testid="delete-confirm"]')!);
		const e = press(document.body, "Escape");
		assert.equal(closed, 0);
		assert.ok(e.defaultPrevented);
	});
	it("delete document", async () => {
		let closed = 0;
		await mount(<DeleteDocumentDialog docId="d" title="T" removal={{ concepts: 0, shared: 0 }} open onClose={() => closed++} onDeleted={noop} />);
		hang();
		await click(document.querySelector('[data-testid="delete-document-confirm"]')!);
		press(document.body, "Escape");
		assert.equal(closed, 0);
	});
	it("and still closes when idle", async () => {
		let closed = 0;
		await mount(<DeleteNodeDialog nodes={[{ id: "a", name: "A" }]} onClose={() => closed++} onDeleted={noop} />);
		press(document.body, "Escape");
		assert.equal(closed, 1);
	});
});

describe("the question dock behind a modal", () => {
	it("stands down: its Tab/Enter row machine does not act while a modal surface is open", async () => {
		const input = { question: "Pick one", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "Because." };
		await mount(<QuestionDock toolName="probe" toolCallId="q1" input={input} expanded dictationClaim={false} onExpand={noop} onSubmit={noop} />);
		assert.ok(press(document.body, "Tab").defaultPrevented, "baseline: the dock claims a plain Tab");
		const modal = document.createElement("div");
		modal.setAttribute("aria-modal", "true");
		document.body.appendChild(modal);
		assert.equal(press(document.body, "Tab").defaultPrevented, false, "with a modal open the dock leaves Tab alone");
		modal.remove();
	});
});

describe("Enter while a modal is open", () => {
	const quiz = { question: "Pick one", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "Because." };
	const answered = async (onSubmit: () => void) => {
		await mount(<QuestionDock toolName="probe" toolCallId="q2" input={quiz} expanded dictationClaim={false} onExpand={noop} onSubmit={onSubmit} />);
		await click(document.querySelector('[role="radio"]')!);
	};

	it("does not submit a dock behind a root-focused modal, and still does with none open", async () => {
		let submitted = 0;
		await answered(() => submitted++);
		press(document.body, "Enter");
		assert.equal(submitted, 1, "baseline: Enter submits the selected answer from anywhere");
		submitted = 0;
		await rerender(
			<>
				<QuestionDock toolName="probe" toolCallId="q2" input={quiz} expanded dictationClaim={false} onExpand={noop} onSubmit={() => submitted++} />
				<RootModal />
			</>,
		);
		const modal = document.querySelector<HTMLElement>('[data-testid="root-modal"]')!;
		const e = press(modal, "Enter");
		assert.equal(submitted, 0, "Enter inside the modal does not reach the dock outside it");
		assert.equal(e.defaultPrevented, false);
	});

	it("the plan popup opened over the canvas workspace is on top: Enter there does not submit the canvas", async () => {
		const tree = (withPlan: boolean) => (
			<App
				inline={
					<>
						{withPlan ? <PlanPopup messages={[]} onClose={noop} /> : null}
						<CanvasWorkspace chatId="c1" callId="k1" question="Draw it" onSubmit={noop} onMinimize={noop} />
					</>
				}
			/>
		);
		await mount(tree(false));
		await rerender(tree(true));
		assert.equal(testId(), "plan-popup");
		assert.equal(press(document.activeElement!, "Enter").defaultPrevented, false, "the canvas, last in the document but below it in the stack, does not take it");
		await rerender(tree(false));
		assert.equal(press(byId("app").querySelector<HTMLElement>('[data-testid="canvas-workspace"]')!, "Enter").defaultPrevented, true, "and it does again once the plan closes");
	});

	it("the canvas workspace, itself modal, keeps submitting: Enter right after opening does not minimise", async () => {
		let minimised = 0;
		await mount(<App inline={<CanvasWorkspace chatId="c1" callId="k1" question="Draw it" onSubmit={noop} onMinimize={() => minimised++} />} />);
		assert.equal(testId(), "canvas-workspace");
		const e = press(document.activeElement!, "Enter");
		assert.equal(minimised, 0);
		assert.ok(e.defaultPrevented, "the workspace's own Enter-submits listener took it");
	});
});

const escape = () => press(document.body, "Escape");

describe("Escape acts on the topmost surface only", () => {
	const plan = (onClose: () => void) => <PlanPopup messages={[]} onClose={onClose} />;
	const canvas = (onMinimize: () => void) => <CanvasWorkspace chatId="c1" callId="k1" question="Draw it" onSubmit={noop} onMinimize={onMinimize} />;

	it("delete confirm (portalled) over the plan popup: one Esc closes the confirm, the next the plan", async () => {
		const closed = { plan: 0, del: 0 };
		const tree = (del: boolean) => (
			<App
				inline={plan(() => closed.plan++)}
				portal={del ? <DeleteSessionDialog chat={{ id: "c", title: "T" }} onClose={() => closed.del++} onDeleted={noop} /> : null}
			/>
		);
		await mount(tree(false));
		await rerender(tree(true));
		escape();
		assert.deepEqual(closed, { plan: 0, del: 1 });
		await rerender(tree(false));
		escape();
		assert.deepEqual(closed, { plan: 1, del: 1 });
	});

	it("the plan popup over the canvas workspace (the real component): one Esc closes the plan, the next minimises the canvas", async () => {
		const closed = { plan: 0, canvas: 0 };
		const tree = (withPlan: boolean) => (
			<App inline={<>{withPlan ? plan(() => closed.plan++) : null}{canvas(() => closed.canvas++)}</>} />
		);
		await mount(tree(false));
		await rerender(tree(true));
		escape();
		assert.deepEqual(closed, { plan: 1, canvas: 0 });
		await rerender(tree(false));
		escape();
		assert.deepEqual(closed, { plan: 1, canvas: 1 });
	});

	it("Settings (opened by its provider) over Add documents: one Esc closes Settings only", async () => {
		let importClosed = 0;
		function Opener() {
			const { open } = useSettingsDialog();
			return <button id="opener" type="button" onClick={() => open()}>open</button>;
		}
		await mount(
			<SettingsDialogProvider>
				<Opener />
				<AddDocumentsDialog open onClose={() => importClosed++} onImported={noop} />
			</SettingsDialogProvider>,
		);
		await click(byId("opener"));
		assert.ok(document.querySelector('[data-testid="settings-dialog"]'));
		escape();
		await act(async () => {});
		assert.equal(document.querySelector('[data-testid="settings-dialog"]'), null);
		assert.equal(importClosed, 0, "the dialog underneath did not act on the same Esc");
		escape();
		assert.equal(importClosed, 1);
	});
});

describe("focus returns somewhere sensible when the opener is gone or was blurred", () => {
	const pointerdown = (el: Element) => void el.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));

	it("a pointer-opened surface whose opener the app blurred (focus-hygiene) gives focus back to it", async () => {
		function Host() {
			const [open, setOpen] = React.useState(false);
			return (
				<>
					<button id="pill" type="button" onClick={(e) => { blurAfterPointerClick(e); setOpen(true); }}>plan</button>
					{open ? <PlanPopup messages={[]} onClose={() => setOpen(false)} /> : null}
				</>
			);
		}
		await mount(<App inline={<Host />} />);
		byId("pill").focus();
		pointerdown(byId("pill"));
		await click(byId("pill"));
		assert.equal(document.activeElement?.tagName, "DIV", "focus is on the popup (the pill was blurred first)");
		press(document.activeElement!, "Escape");
		await act(async () => {});
		assert.equal(document.querySelector('[data-testid="plan-popup"]'), null);
		assert.equal(document.activeElement?.id, "pill");
	});

	it("session delete confirm opened from a menu item that unmounts: focus returns to the row's Session actions button", async () => {
		function Row() {
			const [menu, setMenu] = React.useState(false);
			const [del, setDel] = React.useState(false);
			return (
				<>
					<button id="session-actions" type="button" aria-label="Session actions" onClick={() => setMenu((m) => !m)}>...</button>
					{menu ? (
						<div role="menu">
							<button id="menu-delete" type="button" role="menuitem" onClick={() => { setMenu(false); setDel(true); }}>Delete</button>
						</div>
					) : null}
					{del ? <DeleteSessionDialog chat={{ id: "c", title: "T" }} onClose={() => setDel(false)} onDeleted={noop} /> : null}
				</>
			);
		}
		await mount(<App inline={<Row />} />);
		pointerdown(byId("session-actions"));
		byId("session-actions").focus();
		await click(byId("session-actions"));
		byId("menu-delete").focus();
		pointerdown(byId("menu-delete"));
		await click(byId("menu-delete"));
		assert.equal(testId(), "delete-cancel");
		escape();
		await act(async () => {});
		assert.equal(document.querySelector('[data-testid="delete-session-dialog"]'), null);
		assert.equal(document.activeElement?.id, "session-actions");
	});

	it("with no earlier control to return to, focus goes to the main region, never <body>", async () => {
		function Transient() {
			const [state, setState] = React.useState<"button" | "open" | "closed">("button");
			return (
				<>
					{state === "button" ? <button id="gone" type="button" onClick={() => setState("open")}>x</button> : null}
					{state === "open" ? <AbortTurnDialog mode="turn" onClose={() => setState("closed")} onConfirm={noop} /> : null}
				</>
			);
		}
		await mount(<App portal={<Transient />} />);
		byId("gone").focus();
		await click(byId("gone"));
		await act(async () => {});
		escape();
		await act(async () => {});
		assert.equal(document.activeElement?.tagName, "MAIN");
	});
});
