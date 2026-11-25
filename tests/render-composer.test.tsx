/**
 * Composer render tests — the chat input row (content only; the persistent
 * rounded shell lives in the chat view's overlay so it can morph into the
 * question dock without remounting).
 *
 * Same tsx classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, enterAction } from "../components/composer.tsx";

function render(
	opts: { busy?: boolean; canSend?: boolean; placeholder?: string; nextProblem?: boolean } = {},
) {
	return renderToStaticMarkup(
		<Composer
			busy={opts.busy ?? false}
			value=""
			onChange={() => {}}
			onSend={() => {}}
			onStop={() => {}}
			canSend={opts.canSend ?? true}
			{...(opts.placeholder ? { placeholder: opts.placeholder } : {})}
			{...(opts.nextProblem ? { nextProblem: true, onNext: () => {} } : {})}
		/>,
	);
}

describe("Composer", () => {
	it("chat placeholder + send button", () => {
		const html = render();
		assert.match(html, /Ask, answer, or steer the lesson/, "the default — active sessions");
		assert.ok(html.includes('aria-label="Send"'), "send button present");
	});

	it("placeholder is overridable — the new-session page asks the graph view's question", () => {
		const html = render({ placeholder: "What do you want to learn?" });
		assert.match(html, /What do you want to learn\?/);
		assert.ok(!html.includes("Ask, answer"), "the session placeholder must not ride along");
	});

	it("busy with text: the button STAYS Send (click = steer); busy and empty: it becomes Stop", () => {
		const steering = render({ busy: true, canSend: true });
		assert.ok(steering.includes('aria-label="Send"'), "the steer affordance is clickable mid-turn");
		assert.ok(!steering.includes('aria-label="Stop"'), "no morph while there is text to steer with");
		const idleStop = render({ busy: true, canSend: false });
		assert.ok(idleStop.includes('aria-label="Stop"'), "empty composer: stop replaces send while streaming");
	});

	it("send button radius is 10px = 25% of the 40px button (concentric with the shell)", () => {
		const html = render();
		assert.ok(html.includes("rounded-[10px]"), "send radius = shell radius − row padding");
		assert.ok(html.includes("size-10"), "40px send button (10px = 25%)");
	});

	it("disabled when nothing to send", () => {
		const html = render({ canSend: false });
		assert.ok(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/.test(html), "send disabled");
	});

	it("THE NEXT MORPH (owner round 16 refinement): empty composer in the pause → wide green Next problem", () => {
		const html = render({ canSend: false, nextProblem: true });
		assert.ok(html.includes('data-testid="next-problem-button"'), "the morphed button");
		assert.match(html, /Next problem/, "the label");
		assert.ok(html.includes("bg-success-strong"), "green — the correct-answer register");
		assert.ok(!html.includes('aria-label="Send"'), "the square send is gone in the pause");
	});

	it("typing anything returns the regular send button (canSend outranks the morph)", () => {
		const html = render({ canSend: true, nextProblem: true });
		assert.ok(html.includes('aria-label="Send"'), "regular send while there is text");
		assert.ok(!html.includes('data-testid="next-problem-button"'), "no next morph with text typed");
	});

	it("busy outranks the morph — stop stays reachable", () => {
		const html = render({ busy: true, canSend: false, nextProblem: true });
		assert.ok(html.includes('aria-label="Stop"'), "stop wins the empty lane mid-turn");
		assert.ok(!html.includes('data-testid="next-problem-button"'), "no next morph mid-turn");
	});
});

// The Enter decision (composer steering, 2026-10-03): while a turn runs,
// typed text makes Enter a STEER; Enter with an empty composer stays the
// stop shortcut. (The plan-verdict accept branch died 2026-09-26 with the
// verdict itself — the post-plan reply is a natural text message.) Pure
// function so the static-render harness can pin it (key events can't be
// simulated in renderToStaticMarkup).
describe("enterAction", () => {
	it("busy stream with text: Enter steers (the queued send)", () => {
		assert.equal(enterAction({ busy: true, canSend: true }), "send");
	});

	it("busy stream, empty composer: Enter stops", () => {
		assert.equal(enterAction({ busy: true, canSend: false }), "stop");
	});

	it("idle: send when there is the text, nothing when there is not", () => {
		assert.equal(enterAction({ busy: false, canSend: true }), "send");
		assert.equal(enterAction({ busy: false, canSend: false }), "none");
	});

	it("the practice pause (owner round 16): Enter on an EMPTY composer fires the move-on signal", () => {
		assert.equal(enterAction({ busy: false, canSend: false, nextProblem: true }), "next");
	});

	it("typing anything outranks the pause — text makes Enter a send again", () => {
		assert.equal(enterAction({ busy: false, canSend: true, nextProblem: true }), "send");
	});

	it("busy outranks the pause — steering and Stop keep their lanes", () => {
		assert.equal(enterAction({ busy: true, canSend: false, nextProblem: true }), "stop");
		assert.equal(enterAction({ busy: true, canSend: true, nextProblem: true }), "send");
	});
});

// ─── attachments (components/attachments.tsx) ───────────────────────────────

import { AttachmentEnvContext, admitFiles, imageFilesOf, TOO_MANY_TEXT, UNSUPPORTED_IMAGE_TEXT, type AttachmentDraft } from "../components/attachments.tsx";
import { composerCanSend, composerHold } from "../components/composer.tsx";

function draft(items: AttachmentDraft["items"] = []): AttachmentDraft {
	return {
		chatId: "chat_x",
		items,
		refs: items.filter((i) => i.status === "ready").map((i) => ({ kind: i.kind, id: i.id! })),
		pending: items.some((i) => i.status !== "ready"),
		full: items.length >= 4,
		error: null,
		addFiles: () => {},
		addDrawing: () => {},
		remove: () => {},
		clear: () => {},
	};
}

function renderWith(d: AttachmentDraft, canDraw: boolean, busy = false) {
	return renderToStaticMarkup(
		<AttachmentEnvContext.Provider value={{ chatId: "chat_x", canDraw, openDrawPad: () => {} }}>
			<Composer busy={busy} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend attachments={d} />
		</AttachmentEnvContext.Provider>,
	);
}

describe("Composer attachments", () => {
	it("Add image is always offered; Draw only on a device that can draw", () => {
		const phone = renderWith(draft(), false);
		assert.ok(phone.includes('data-testid="attach-image"'));
		assert.ok(!phone.includes('data-testid="attach-drawing"'));
		assert.ok(renderWith(draft(), true).includes('data-testid="attach-drawing"'));
	});

	it("the cards sit in a strip above the textarea, each removable", () => {
		const html = renderWith(draft([
			{ key: "a", kind: "image", status: "ready", id: "img_0000000000000001", previewUrl: "blob:x" },
			{ key: "b", kind: "drawing", status: "ready", id: "drw_000000000001" },
		]), true);
		assert.ok(html.indexOf('data-testid="attachment-strip"') < html.indexOf("<textarea"), "the strip comes first");
		assert.equal(html.match(/data-testid="attachment-card"/g)?.length, 2);
		assert.equal(html.match(/data-testid="attachment-remove"/g)?.length, 2);
		assert.ok(html.includes("/api/chats/chat_x/drawings/drw_000000000001?format=png"), "a drawing shows its exported PNG");
		assert.ok(!renderWith(draft(), true).includes('data-testid="attachment-strip"'), "no strip without attachments");
	});

	it("four attachments fill the field: the buttons switch off", () => {
		const four = draft([1, 2, 3, 4].map((n) => ({ key: `k${n}`, kind: "image" as const, status: "ready" as const, id: `img_000000000000000${n}` })));
		const html = renderWith(four, true);
		assert.match(html, /data-testid="attach-image"[^>]*disabled=""/);
	});

	it("images alone can be sent, but not while one uploads, and not as a steer", () => {
		assert.equal(composerCanSend({ sendAllowed: true, busy: false, text: "", dictationActive: false, readyAttachments: 1 }), true);
		assert.equal(composerCanSend({ sendAllowed: true, busy: true, text: "", dictationActive: false, readyAttachments: 1 }), false, "busy and empty stays Stop");
		assert.equal(composerHold({ busy: false, canSend: true, attachmentCount: 1, attachmentsPending: true }), true);
		assert.equal(composerHold({ busy: true, canSend: true, attachmentCount: 1, attachmentsPending: false }), true, "text plus images mid-turn waits");
		assert.equal(composerHold({ busy: true, canSend: true, attachmentCount: 0, attachmentsPending: false }), false, "text alone still steers");
		assert.equal(enterAction({ busy: true, canSend: true, hold: true }), "none", "a held send never stops the turn");
	});

	it("the client mirrors the limits: accepted types only, at most four", () => {
		const f = (type: string) => ({ type });
		assert.deepEqual(admitFiles([f("image/png"), f("image/webp")], 3), { accepted: [f("image/png")], error: TOO_MANY_TEXT });
		assert.deepEqual(admitFiles([f("image/svg+xml"), f("image/gif")], 0), { accepted: [f("image/gif")], error: UNSUPPORTED_IMAGE_TEXT });
		const files = [new File(["x"], "a.png", { type: "image/png" }), new File(["x"], "a.txt", { type: "text/plain" })];
		assert.deepEqual(imageFilesOf({ files: files as unknown as FileList }).map((x) => x.name), ["a.png"], "a text paste is left alone");
	});
});
