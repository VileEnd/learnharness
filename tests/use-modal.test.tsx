import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPortal } from "react-dom";
import { activeId, byId, dom, mount, press, rerender, unmount } from "./helpers/modal-dom.tsx";
import { nextTabTarget, useModal } from "../components/ui/use-modal.ts";
import { useRef } from "react";

function Modal({ id, children }: { id: string; children?: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useModal(ref);
	return createPortal(
		<div ref={ref} id={id} role="dialog" aria-modal="true">
			{children ?? (
				<>
					<button id={`${id}-a`} type="button">a</button>
					<button id={`${id}-b`} type="button" data-autofocus>b</button>
					<button id={`${id}-off`} type="button" disabled>off</button>
					<button id={`${id}-c`} type="button">c</button>
				</>
			)}
		</div>,
		document.body,
	);
}

/** The app behind the modals: an opener button and a composer. */
function Page({ modals = [] as string[], extra }: { modals?: string[]; extra?: React.ReactNode }) {
	return (
		<>
			<main id="page">
				<button id="opener" type="button">open</button>
				<textarea id="composer" />
			</main>
			<aside id="side">
				<button id="side-btn" type="button">side</button>
			</aside>
			{extra}
			{modals.map((m) => <Modal key={m} id={m} />)}
		</>
	);
}

async function openFromOpener(modals: string[]) {
	byId("opener").focus();
	await rerender(<Page modals={modals} />);
}

afterEach(unmount);

describe("useModal", () => {
	it("moves focus to the data-autofocus control, else the first tabbable, else the surface", async () => {
		await mount(<Page />);
		byId("opener").focus();
		await rerender(<Page modals={["m"]} />);
		assert.equal(activeId(), "m-b", "data-autofocus wins over the first control");

		await rerender(<Page />);
		await rerender(
			<Page extra={<Modal id="plain"><button id="p1" type="button">1</button><button id="p2" type="button">2</button></Modal>} />,
		);
		assert.equal(activeId(), "p1", "first tabbable when nothing is marked");

		await rerender(<Page />);
		await rerender(<Page extra={<Modal id="bare"><p>text only</p></Modal>} />);
		assert.equal(activeId(), "bare", "the surface itself when nothing inside is tabbable");
	});

	it("focuses the surface itself when it carries data-autofocus, and Tab then enters at either end", async () => {
		function Marked() {
			const ref = useRef<HTMLDivElement>(null);
			useModal(ref);
			return createPortal(
				<div ref={ref} id="marked" role="dialog" aria-modal="true" data-autofocus>
					<button id="m1" type="button">1</button>
					<button id="m2" type="button">2</button>
				</div>,
				document.body,
			);
		}
		await mount(<Page extra={<Marked />} />);
		assert.equal(activeId(), "marked");
		press(byId("marked"), "Tab");
		assert.equal(activeId(), "m1");
		byId("marked").focus();
		press(byId("marked"), "Tab", { shiftKey: true });
		assert.equal(activeId(), "m2");
	});

	it("keeps focus that an element inside already took (autoFocus)", async () => {
		await mount(<Page />);
		function Taker() {
			const ref = useRef<HTMLDivElement>(null);
			useModal(ref);
			return createPortal(
				<div ref={ref} role="dialog" aria-modal="true">
					<button id="first" type="button">1</button>
					<input id="field" ref={(el) => el?.focus()} />
				</div>,
				document.body,
			);
		}
		await rerender(<Page extra={<Taker />} />);
		assert.equal(activeId(), "field");
	});

	it("Tab and Shift+Tab cycle inside, skipping disabled controls, and wrap at both ends", async () => {
		await mount(<Page />);
		await openFromOpener(["m"]);
		byId("m-c").focus();
		let e = press(byId("m-c"), "Tab");
		assert.equal(activeId(), "m-a", "Tab from the last wraps to the first");
		assert.ok(e.defaultPrevented);
		e = press(byId("m-a"), "Tab", { shiftKey: true });
		assert.equal(activeId(), "m-c", "Shift+Tab from the first wraps to the last");
		press(byId("m-c"), "Tab", { shiftKey: true });
		assert.equal(activeId(), "m-b", "the disabled control is skipped going back");
		press(byId("m-b"), "Tab");
		assert.equal(activeId(), "m-c", "and going forward");
	});

	it("claims Tab before the global handler (no thinking-level cycle behind a modal)", async () => {
		await mount(<Page />);
		let windowSaw = 0;
		const spy = () => windowSaw++;
		dom.window.addEventListener("keydown", spy);
		await openFromOpener(["m"]);
		press(byId("m-b"), "Tab");
		press(byId("m-b"), "Tab", { shiftKey: true });
		dom.window.removeEventListener("keydown", spy);
		assert.equal(windowSaw, 0);
	});

	it("pulls lost focus (a control that just got disabled) back inside, and leaves modified Tab alone", async () => {
		await mount(<Page />);
		await openFromOpener(["m"]);
		byId("m-c").setAttribute("disabled", "");
		assert.equal(activeId(), "m-b", "model: the active control is still enabled here");
		(document.activeElement as HTMLElement).blur();
		assert.equal(activeId(), "", "focus is on <body>");
		const e = press(document.body, "Tab");
		assert.ok(e.defaultPrevented);
		assert.equal(activeId(), "m-a");
		assert.equal(press(byId("m-a"), "Tab", { ctrlKey: true }).defaultPrevented, false);
	});

	it("does not take a Tab someone inside already claimed, or one from a live popover outside", async () => {
		await mount(<Page />);
		await openFromOpener(["m"]);
		const claimer = byId("m-a");
		claimer.addEventListener("keydown", (ev) => ev.preventDefault());
		press(claimer, "Tab");
		assert.equal(activeId(), "m-b", "focus did not move: the claimed Tab is left alone");
		const menu = document.createElement("div");
		menu.innerHTML = '<button id="menu-item" type="button">item</button>';
		document.body.appendChild(menu);
		byId("menu-item").focus();
		assert.equal(press(byId("menu-item"), "Tab").defaultPrevented, false, "a popover opened from the modal keeps its own Tab");
	});

	it("makes the rest of the app inert while open and not after", async () => {
		await mount(<Page />);
		await openFromOpener(["m"]);
		assert.ok(byId("app").hasAttribute("inert"), "the app root is inert");
		assert.ok(!byId("m").hasAttribute("inert") && !byId("m").parentElement!.hasAttribute("inert"));
		await rerender(<Page />);
		assert.ok(!byId("app").hasAttribute("inert"));
		assert.equal(document.querySelectorAll("[inert]").length, 0);
	});

	it("inerts siblings along the ancestor chain for a surface inside the app (session overlay)", async () => {
		function Inline() {
			const ref = useRef<HTMLDivElement>(null);
			useModal(ref);
			return <div ref={ref} id="inline" role="dialog" aria-modal="true"><button id="inline-x" type="button">x</button></div>;
		}
		await mount(
			<section id="area">
				<div id="scroller"><button id="in-scroller" type="button">s</button></div>
				<div id="slot" />
			</section>,
		);
		await rerender(
			<section id="area">
				<div id="scroller"><button id="in-scroller" type="button">s</button></div>
				<Inline />
			</section>,
		);
		assert.ok(byId("scroller").hasAttribute("inert"));
		assert.ok(!byId("area").hasAttribute("inert"), "the ancestor holding the surface stays live");
		assert.ok(!byId("inline").hasAttribute("inert"));
		assert.equal(activeId(), "inline-x");
	});

	it("never removes an inert attribute it did not set", async () => {
		await mount(<Page extra={<div id="pre" inert />} />);
		await rerender(<Page extra={<div id="pre" inert />} modals={["m"]} />);
		await rerender(<Page extra={<div id="pre" inert />} />);
		assert.ok(byId("pre").hasAttribute("inert"));
	});

	it("returns focus to the opener on close, only while it is still in the document", async () => {
		await mount(<Page />);
		await openFromOpener(["m"]);
		assert.equal(activeId(), "m-b");
		await rerender(<Page />);
		assert.equal(activeId(), "opener");

		await openFromOpener(["m"]);
		await rerender(<Page extra={null} modals={["m"]} />);
		byId("opener").remove();
		await rerender(<Page />);
		assert.notEqual(activeId(), "opener", "a removed opener is not focused");
	});

	it("stacked: inert stays until the last closes and focus returns to each opener in order", async () => {
		await mount(<Page />);
		await openFromOpener(["one"]);
		const settingsLike = byId("one-c");
		settingsLike.focus();
		await rerender(<Page modals={["one", "two"]} />);
		assert.equal(activeId(), "two-b");
		assert.ok(byId("one").hasAttribute("inert"), "the lower modal is inert under the upper");
		assert.ok(byId("app").hasAttribute("inert"));

		await rerender(<Page modals={["one"]} />);
		assert.equal(activeId(), "one-c", "back to the control that opened the upper modal");
		assert.ok(!byId("one").hasAttribute("inert"));
		assert.ok(byId("app").hasAttribute("inert"), "the page is still inert: one modal remains");

		await rerender(<Page />);
		assert.equal(activeId(), "opener");
		assert.equal(document.querySelectorAll("[inert]").length, 0);
	});

	it("stacked, closed out of order: the upper one inherits the lower one's opener", async () => {
		await mount(<Page />);
		await openFromOpener(["one"]);
		await rerender(<Page modals={["one", "two"]} />);
		await rerender(<Page modals={["two"]} />);
		assert.ok(byId("app").hasAttribute("inert"), "still inert under the remaining modal");
		await rerender(<Page />);
		assert.equal(activeId(), "opener", "not lost with the closed lower modal");
		assert.equal(document.querySelectorAll("[inert]").length, 0);
	});

	it("a surface that stays mounted opens and closes with `active` (opener captured at each opening)", async () => {
		function Stays({ open }: { open: boolean }) {
			const ref = useRef<HTMLDivElement>(null);
			useModal(ref, open);
			return open ? createPortal(<div ref={ref} id="stays" role="dialog" aria-modal="true"><button id="s1" type="button">1</button></div>, document.body) : null;
		}
		await mount(<Page extra={<Stays open={false} />} />);
		byId("opener").focus();
		await rerender(<Page extra={<Stays open />} />);
		assert.equal(activeId(), "s1");
		assert.ok(byId("app").hasAttribute("inert"));
		await rerender(<Page extra={<Stays open={false} />} />);
		assert.equal(activeId(), "opener");
		assert.equal(document.querySelectorAll("[inert]").length, 0);
		byId("composer").focus();
		await rerender(<Page extra={<Stays open />} />);
		await rerender(<Page extra={<Stays open={false} />} />);
		assert.equal(activeId(), "composer", "the second opening remembers its own opener");
	});

	it("only the topmost modal handles Tab", async () => {
		await mount(<Page />);
		await openFromOpener(["one"]);
		await rerender(<Page modals={["one", "two"]} />);
		byId("two-c").focus();
		press(byId("two-c"), "Tab");
		assert.equal(activeId(), "two-a");
	});
});

describe("nextTabTarget", () => {
	it("wraps at both ends and handles an element that is not in the list", () => {
		const els = ["a", "b", "c"].map((id) => {
			const el = document.createElement("button");
			el.id = id;
			document.body.appendChild(el);
			return el;
		});
		assert.equal(nextTabTarget(els, els[2]!, false)?.id, "a");
		assert.equal(nextTabTarget(els, els[0]!, true)?.id, "c");
		assert.equal(nextTabTarget(els, els[0]!, false)?.id, "b");
		assert.equal(nextTabTarget([], els[0]!, false), null);
		const stray = document.createElement("div");
		document.body.insertBefore(stray, els[1]!);
		assert.equal(nextTabTarget(els, stray, false)?.id, "b", "next in document order");
		assert.equal(nextTabTarget(els, stray, true)?.id, "a", "previous in document order");
		assert.equal(nextTabTarget(els, null, true)?.id, "c");
		stray.remove();
		els.forEach((el) => el.remove());
	});
});
