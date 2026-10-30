/** Render tests: low-context hint in the custom endpoint editor, and unavailable allowed models in the policy editor. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ui-hints-"));
process.env.LH_DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { CustomEndpointEditor } = await import("../components/settings/custom-endpoint.tsx");
const { PolicyFields } = await import("../components/settings/users-section.tsx");

const status = (context?: number) => ({
	configured: true,
	config: {
		baseUrl: "http://192.0.2.10:11434/v1",
		mode: "keyless" as const,
		pricing: "free" as const,
		snapshot: [{ id: "qwen3:8b", name: "qwen3:8b" }, { id: "big", name: "big", context: 65536 }],
		models: context === undefined ? {} : { "qwen3:8b": { context } },
	},
});
const render = (s: ReturnType<typeof status>) =>
	renderToStaticMarkup(createElement(CustomEndpointEditor, { status: s as never, etag: "e", onChanged: () => {}, onReload: () => {} }));

test("a model with a small (or default) context shows the compression hint", () => {
	const html = render(status());
	assert.match(html, /custom-lowcontext-qwen3:8b/);
	assert.match(html, /compressed on almost every turn/);
	assert.doesNotMatch(html, /custom-lowcontext-big/);
});

test("pinning a large context removes the hint", () => {
	assert.doesNotMatch(render(status(65536)), /custom-lowcontext-qwen3:8b/);
});

test("a held allowed model missing from the catalog is a checked, removable (unavailable) row", () => {
	const html = renderToStaticMarkup(
		createElement(PolicyFields, {
			value: { slots: {}, allowedModels: ["custom:qwen3:8b"], monthlyCapUsd: null },
			catalog: [],
			busy: false,
			idPrefix: "user-u1",
			onSave: () => {},
			saveLabel: "Save",
		}),
	);
	assert.match(html, /custom:qwen3:8b \(unavailable\)/);
	assert.match(html, /<input type="checkbox" checked=""[^>]*\/>custom:qwen3:8b \(unavailable\)/);
});
