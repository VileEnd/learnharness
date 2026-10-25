/** The export's graph viewer (src/core/okf-viz.ts): the embedded graph mirrors the bundle's links. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderOkfViewer } from "../src/core/okf-viz.ts";
import { VIZ_CSS, VIZ_HTML, VIZ_JS } from "../src/core/okf-viz/assets.ts";

const fm = (type: string, title: string) => `---\ntype: "${type}"\ntitle: "${title}"\n---\n`;
const graphOf = (html: string) => {
	const m = /window\.BUNDLE = (.*);\n/.exec(html);
	assert.ok(m);
	return JSON.parse(m[1]!) as { nodes: Array<{ data: { id: string } }>; edges: Array<{ data: { id: string } }>; bodies: Record<string, string> };
};

test("viewer graph mirrors the bundle links", () => {
	const html = renderOkfViewer([
		{ path: "a.md", content: `${fm("Proposition", "A")}See [b](sub/b.md) and [again](sub/b.md#x).\n` },
		{ path: "sub/b.md", content: `${fm("Proposition", "B")}No links back.\n` },
		{ path: "c.md", content: `${fm("Topic", "C")}no links\n` },
	]);
	const g = graphOf(html);
	assert.deepEqual(g.nodes.map((n) => n.data.id), ["a", "c", "sub/b"]);
	assert.deepEqual(g.edges.map((e) => e.data.id), ["a__sub/b"]);
});

test("viewer ignores index files and external links", () => {
	const g = graphOf(
		renderOkfViewer([
			{ path: "index.md", content: "# Document\n\n* [a](a.md)\n" },
			{ path: "log.md", content: "# Log\n" },
			{ path: "a.md", content: `${fm("Document", "A")}[web](https://example.com/x.md) [chat](learnharness:chat/c1) [esc](../../x.md)\n` },
		]),
	);
	assert.deepEqual(g.nodes.map((n) => n.data.id), ["a"]);
	assert.deepEqual(g.edges, []);
});

test("a script terminator in a body cannot break out of the page", () => {
	const html = renderOkfViewer([{ path: "a.md", content: `${fm("Document", "A")}</script><b>$&</b>\n` }]);
	assert.equal(graphOf(html).bodies.a, "</script><b>$&</b>\n");
	assert.ok(!/<\/script><b>/.test(html));
});

test("the embedded assets match the vendored files", () => {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "okf-viz");
	assert.equal(VIZ_HTML, fs.readFileSync(path.join(dir, "viz.html"), "utf-8"));
	assert.equal(VIZ_JS, fs.readFileSync(path.join(dir, "viz.js"), "utf-8"));
	assert.equal(VIZ_CSS, fs.readFileSync(path.join(dir, "viz.css"), "utf-8"));
});
