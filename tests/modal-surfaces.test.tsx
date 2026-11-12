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
		const modal = document.createElement("div");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("tabindex", "-1");
		document.body.appendChild(modal);
		const e = press(modal, "Enter");
		assert.equal(submitted, 0, "Enter inside the modal does not reach the dock outside it");
		assert.equal(e.defaultPrevented, false);
		modal.remove();
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
