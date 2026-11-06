import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableBody } from "../components/chain-table.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
let focused: Element | undefined;
dom.window.HTMLElement.prototype.focus = function () {
	focused = this;
};
(dom.window.HTMLInputElement.prototype as { select: () => void }).select = () => {};

it("Mod+F (lh:kbd-find) while the chains view is mounted focuses ITS search, and stops when unmounted", async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<ChainTableBody
				nodes={[]}
				chains={[]}
				sessions={{}}
				fileSources={{}}
				query=""
				onQuery={() => {}}
				sort={{ col: "name", dir: 1 }}
				onSort={() => {}}
				selection={new Set()}
				expandedClusters={new Set()}
				expandedChains={new Set()}
				onToggleCluster={() => {}}
				onToggleChain={() => {}}
				onToggleNodes={() => {}}
				onClear={() => {}}
				onDelete={() => {}}
				onClose={() => {}}
			/>,
		);
	});
	window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-find"));
	assert.equal(focused, document.querySelector('[data-testid="chain-table-search"]'));
	await act(async () => root.unmount());
	focused = undefined;
	window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-find"));
	assert.equal(focused, undefined);
});
