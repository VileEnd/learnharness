import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { DialogContext } from "../components/settings/settings-dialog.tsx";
import { OpenSettingsDialog } from "../components/settings/open-settings-dialog.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

it("the /settings page opens the settings dialog and leaves the URL for the home", async () => {
	const opened: unknown[][] = [];
	const replaced: string[] = [];
	const router = { replace: (href: string) => void replaced.push(href) } as never;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<AppRouterContext.Provider value={router}>
				<DialogContext.Provider value={{ open: (...args) => void opened.push(args) }}>
					<OpenSettingsDialog />
				</DialogContext.Provider>
			</AppRouterContext.Provider>,
		);
	});
	assert.ok(opened.length >= 1, "the dialog was asked to open");
	assert.ok(replaced.includes("/chat/new"));
	await act(async () => root.unmount());
});
