import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CacheRetentionSection, CacheRetentionSectionView } from "../components/settings/cache-retention-section.tsx";

test("the admin row states the trade-off and shows the saved choice", () => {
	const html = renderToStaticMarkup(<CacheRetentionSectionView value="long" loaded busy={false} error={null} onChange={() => {}} />);
	assert.match(html, /2× the input price instead of 1\.25×/);
	assert.match(html, /5 to 60 minutes/);
	assert.match(html, /<option value="long" selected/);
	assert.match(html, /<option value="short">Short, about 5 min \(default\)/);
});

test("non-admins see nothing", () => {
	assert.equal(renderToStaticMarkup(<CacheRetentionSection isAdmin={false} />), "");
});
