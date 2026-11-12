import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { PartBoundary } from "../components/part-boundary.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

it("one malformed part shows an inline fallback and the rest of the chat still renders", async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const realError = console.error;
	console.error = () => {}; // React and the boundary both log the caught throw
	try {
		await act(async () => {
			root.render(
				<div>
					<PartBoundary render={() => <p>before</p>} />
					{/* the real failure: a persisted answer whose shape is wrong */}
					<PartBoundary render={() => <AnsweredCard answer={{} as never} input={undefined as never} />} />
					<PartBoundary render={() => { throw new Error("part logic"); }} />
					<PartBoundary render={() => <p>after</p>} />
				</div>,
			);
		});
	} finally {
		console.error = realError;
	}
	const text = host.textContent ?? "";
	assert.match(text, /before/);
	assert.match(text, /after/);
	assert.equal(host.querySelectorAll('[data-testid="part-error"]').length, 2);
	assert.match(text, /This part could not be displayed\./);
	await act(async () => root.unmount());
});
