/**
 * Mount a React element in a linkedom document and wait until `ready` holds.
 * The statement surfaces load their Markdown renderer on demand
 * (components/statement-text.tsx), so a static render shows only the plain
 * fallback; these tests mount, let the chunk load, then inspect the DOM.
 */
import React, { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

export async function mountSettled(
	element: ReactElement,
	ready: (host: HTMLElement) => boolean,
): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
	(globalThis as Record<string, unknown>).React = React;
	const dom = parseHTML("<html><body></body></html>");
	const globals = { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	Object.assign(globalThis, globals);
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host);
	const unmount = async () => {
		await act(async () => root.unmount());
		for (const key of Object.keys(globals)) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	try {
		await act(async () => root.render(element));
		for (let i = 0; i < 200 && !ready(host); i++) {
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
		}
		if (!ready(host)) throw new Error("the lazy renderer never appeared");
	} catch (error) {
		await unmount();
		throw error;
	}
	return { host, unmount };
}

/** The renderer has replaced the plain fallback. */
export const rendered = (host: HTMLElement) => host.querySelector(".lh-prose") !== null;
