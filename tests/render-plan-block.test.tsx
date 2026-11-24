import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanBlock, PlanPopup, type PopupMessage } from "../components/plan-block.tsx";
import {
	blockLayout,
	chartMeasure,
	topoFor,
	edgePathD,
	GAP_X,
	NODE_W_MIN,
	PAD_X,
	type LabelMeasure,
} from "../components/plan-layout.ts";
import type { PlanBlockData, PlanTree } from "../src/core/contracts.ts";
import { AppearanceProvider } from "../components/settings/appearance.tsx";

// Plan blocks: the pure layered layout, the frozen-snapshot rendering
// (full = borderless + column-filling
// with the glowing current), and the popup's LIVE derivation.

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

/** One node laid out alone: its wrapped lines and box. */
function single(title: string, measure: LabelMeasure = chartMeasure) {
	const L = blockLayout([{ id: "n", title }], [], measure);
	return { lines: L.lines.get("n")!, w: L.nodeW.get("n")!, h: L.nodeH.get("n")!, lineH: L.lineH };
}

/** A monospace stand-in at 11px (every character 6.6px, JetBrains Mono's
 *  advance) that wraps at spaces like the browser's breaker would. */
const monoWidth = (s: string) => [...s].length * 6.6;
const mono: LabelMeasure = {
	fontSize: 11,
	width: monoWidth,
	lines(title, maxWidth) {
		const lines: string[] = [];
		for (const word of title.trim().split(/\s+/)) {
			const last = lines[lines.length - 1];
			if (last !== undefined && monoWidth(`${last} ${word}`) <= maxWidth) lines[lines.length - 1] = `${last} ${word}`;
			else lines.push(word);
		}
		return lines;
	},
};

describe("plan block layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges, chartMeasure);
		// Text-first sizing (owner, plan-hug round 2026-10-07): these short
		// titles hug to the minimum — no more fixed 160px slabs.
		assert.equal(layout.nodeW.get("a"), NODE_W_MIN); // est ≈ 50 → floored at the min
		assert.equal(layout.nodeW.get("c"), NODE_W_MIN); // est ≈ 59.9
		assert.equal(layout.width, NODE_W_MIN);
		// 44 tall each: two 13px rows + 9px top/bottom, derived from 11px.
		assert.equal(layout.height, 3 * 44 + 2 * 48);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(
			nodes,
			[
				{ from: "r", to: "x" },
				{ from: "r", to: "y" },
				{ from: "ghost", to: "r" }, // dangling: ignored defensively
			],
			chartMeasure,
		);
		const W = NODE_W_MIN;
		assert.equal(layout.width, 2 * W + GAP_X);
		// Root centered over its two children: (2*W+GAP - W)/2
		assert.equal(layout.x.get("r"), (2 * W + GAP_X - W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === W + GAP_X);
	});

	it("edgePathD draws dagre's route through curveBasis — mouth pulled back from the border", () => {
		// Straight 3-point route (source border → mid → target border): the
		// basis curve starts exactly at the border point; the END pulls
		// back by HEAD_TIP_OVERHANG + the docking gap (92 − 2.359 − 2.667) so
		// the head's TIP floats 2.67 short of the border with its mouth at
		// the path's end, on a straight shaft (owner, rounds 11–12; the head
		// + gap scaled ⅔ with the 1px lines, 2026-09-26).
		const d = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }]);
		assert.ok(d.startsWith("M80,44"), "starts at the source border point");
		assert.ok(d.endsWith("L80,86.974"), "mouth pulled back; tip floats 2.67 off the border");
		// The whole run stays on-axis (every x is 80): a collinear route
		// renders straight — the shaft stub never bends a straight edge.
		const xs = [...d.matchAll(/(?:[MLC]|,)(-?[\d.]+),/g)].map((m) => m[1]);
		assert.ok(xs.length > 0 && xs.every((v) => v === "80"), "collinear route renders on-axis");
		// A perpendicular entry with the target box is the SAME geometry.
		const pd = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }], { x: 0, y: 92, w: 160, h: 44 });
		assert.equal(pd, d);
	});

	it("edgePathD clamps the entry to ±40° of the face perpendicular (owner, round 14)", () => {
		const box = { x: 20, y: 100, w: 160, h: 44 };
		// A 60° tilt into the top face swings to the 40° cone edge: the
		// mouth lands at (97.726, 93.289) and the final segment runs at
		// exactly 40° (Δx/Δy = tan 40°). The tip floats DOCK_GAP (4) off the
		// face along the normal: border (100,100) → tip (100,96).
		const clamped = edgePathD([{ x: 70, y: 70 }, { x: 100, y: 100 }], box);
		assert.ok(clamped.endsWith("L98.484,95.526"), "swung to the cone edge");
		// final L's from-point is the previous number pair; recompute direction
		const nums = [...clamped.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
		const ax = nums[nums.length - 4]!;
		const ay = nums[nums.length - 3]!;
		const bx = nums[nums.length - 2]!;
		const by = nums[nums.length - 1]!;
		assert.ok(Math.abs((bx - ax) / (by - ay) - Math.tan((40 * Math.PI) / 180)) < 0.01, "40° cone edge");
		// Tip = mouth + u'·overhang floats 2.67 above the face.
		const tipY = by + 0.766 * 2.359;
		assert.ok(Math.abs(tipY - 97.333) < 0.01, "docking gap along the face normal");
		// A shallow (~9.5°) tilt is WITHIN the limit: no swing.
		const free = edgePathD([{ x: 90, y: 40 }, { x: 100, y: 100 }], box);
		assert.ok(free.endsWith("L99.612,95.006"), "unclamped within the cone");
	});

	it("takes its lines from the measure, capped at 12.75 em, and never drops content", () => {
		assert.deepEqual(single("Chain rule intuition").lines, ["Chain rule intuition"]);
		assert.deepEqual(single("Chain rule intuition and fluency").lines, ["Chain rule intuition and", "fluency"]);
		// A word is never split: one wider than the cap gets its own line and
		// widens its box (the old 28-character hard chunking is gone).
		const s = single("supercalifragilisticexpialidocious word");
		assert.deepEqual(s.lines, ["supercalifragilisticexpialidocious", "word"]);
		assert.equal(s.w, Math.ceil(chartMeasure.width("supercalifragilisticexpialidocious")) + 2 * PAD_X);
		assert.equal(single("Symmetry and orthogonal complements").w, 149); // 117 + 2×16
		assert.equal(single("a").w, NODE_W_MIN);
	});

	it("sizes every box from the MEASURED widths, not the Source Sans chart", () => {
		// The browser's real font decides: in a monospace measure the same
		// title wraps onto more lines and each box hugs its widest measured
		// line plus 16px a side — every line fits inside its box.
		const title = "Orthogonal diagonalisation and the spectral theorem in practice";
		const m = single(title, mono);
		const widest = Math.max(...m.lines.map(monoWidth));
		assert.equal(m.w, Math.ceil(widest) + 2 * PAD_X);
		for (const line of m.lines) assert.ok(monoWidth(line) + 2 * PAD_X <= m.w);
		assert.ok(m.lines.length > single(title).lines.length, "the wider font wraps onto more lines");
		assert.ok(m.lines.length * m.lineH <= m.h, "the box grows with its lines");
	});
});

describe("plan block render", () => {
	it("full block: borderless, column-filling, statuses AS CARRIED (never re-derived)", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-09-09T12:00:00Z",
			current: null,
			nodes: [
				{ id: "a", title: "Alpha node", status: "visited" },
				{ id: "b", title: "Beta node", status: "upcoming" },
			],
			edges: [{ from: "a", to: "b" }],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.match(html, /data-testid="plan-block-full"/);
		// Borderless: the wrapper carries no border/rounded chrome.
		assert.ok(!/data-testid="plan-block-full"[^>]*border/.test(html), "no wrapping chrome");
		// Fills the column UP TO the chat-font cap: the svg is w-full +
		// mx-auto with maxWidth = extent × prose size / label size, so node
		// text never renders past the prose size (owner, plan-graph round 1).
		assert.match(html, /<svg[^>]*class="block h-auto w-full mx-auto"/);
		// The reading font, not the mono UI font (owner, 2026-09-26) — via the
		// runtime var (the font-prose utility would bake the @theme literal
		// and ignore the Appearance reading-font override).
		assert.match(html, /<svg[^>]*font-family:var\(--font-prose\)/);
		// Lines + outlines at the app's standard 1px border weight (owner,
		// 2026-09-26; was 1.5).
		assert.match(html, /<rect[^>]*stroke-width="1"/);
		assert.match(html, /max-width:162\.91px/); // (96+16) × 16/11: 11px labels reach at most the 16px prose size
		// The cap follows the reading size picked in Settings.
		const big = renderToStaticMarkup(
			<AppearanceProvider initialAppearance={{ proseFontSize: 20 }}>
				<PlanBlock data={data} onOpen={() => {}} />
			</AppearanceProvider>,
		);
		assert.match(big, /max-width:203\.64px/); // (96+16) × 20/11
		// Centered text (owner, plan-hug round 2026-10-07): every title line
		// anchors to its box's midline — the old x=12 left inset is gone.
		assert.match(html, /<text[^>]*x="48"[^>]*text-anchor="middle"/); // 96/2
		assert.ok(!/x="12"/.test(html), "no left-inset text");
		// Each line centers on its own row: no font-specific baseline offset.
		assert.match(html, /<text[^>]*dominant-baseline="central"/);
		// The label probe: a hidden, unscaled sibling svg in the same font
		// cascade (the browser measures the labels there after hydration).
		const probe = html.match(/<\/svg><svg ([^>]*data-plan-probe=""[^>]*)>/);
		assert.ok(probe, "the measuring probe follows the diagram as a sibling");
		assert.match(probe[1]!, /aria-hidden="true" visibility="hidden"/);
		assert.match(probe[1]!, /font-family:var\(--font-prose\)/);
		assert.doesNotMatch(probe[1]!, /viewBox=/);
		// The in-chat block speaks the dock language (owner, 2026-10-07):
		// lighter-background boxes like the composer shells — with WHITE
		// outlines (owner follow-up: gray fill good, box edges stay white —
		// the strong line ink, white in Default, since themes step 2).
		assert.match(html, /<rect[^>]*class="fill-card stroke-line-strong"/);
		// Two stacked nodes: 2*NODE_H + GAP_Y = 136 extent + GRAPH_PAD on
		// every side (strokes/glow never clip at the edges). The width
		// rides the hug now: 96-min boxes, not the old 160 slabs.
		assert.match(html, /viewBox="-8 -8 112 152"/);
		// Snapshot statuses render as carried.
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="upcoming"/);
		assert.ok(html.includes('aria-label="Open the full plan"'), "the trigger names itself (tooltip copy)");
	});

});

describe("plan popup (live derivation)", () => {
	function messages(): PopupMessage[] {
		return [
			{
				parts: [
					{
						type: "tool-plan_init",
						state: "output-available",
						output: { ok: true, tree: CHAIN },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "output-available",
						input: { nodeId: "a" },
						output: { correct: true },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "input-available",
						input: { nodeId: "b" },
					},
				],
			},
		];
	}

	it("derives statuses at click time: latest tagged call → current, earlier → visited (glowing)", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={messages()} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-popup"/);
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="current"/);
		assert.match(html, /data-testid="plan-node-c" data-status="upcoming"/);
		// The current node is the glow target: a faint yellow fill, blurred
		// so it bleeds over the edges — static, no pulse (owner, round 6).
		assert.match(html, /fill-yellow-400\/25/);
		assert.match(html, /feGaussianBlur/);
		assert.doesNotMatch(html, /animate-pulse/);
		// Arrows into not-yet-visited nodes are grayed out (owner, round 6).
		assert.match(html, /marker-end="url\(#.*-dim\)"/);
		assert.match(html, /live — statuses derive from your check outcomes/);
		// No top-left flash: at static render settled=false, so the diagram
		// wrapper paints at opacity 0 — the fit runs in an effect AFTER the
		// first paint and the chart would otherwise flash at the initial
		// top-left zoom:1 state for a frame (owner report, 2026-09-19;
		// transition-gating alone didn't hide it).
		assert.match(html, /opacity: ?0[;,}]/, "diagram hidden until the first fit applies");
	});

	it("dims an arrow when EITHER end is gray — white needs both ends white (owner, 2026-09-26)", () => {
		// x upcoming → y visited: the OLD rule (target-only) painted this
		// white; the new rule keeps it gray — a gray box's outgoing arrows
		// stay gray even into covered territory. y → z (visited → current)
		// stays white: BOTH ends white.
		const tree: PlanTree = {
			nodes: [
				{ id: "x", title: "Gray origin" },
				{ id: "y", title: "Covered middle" },
				{ id: "z", title: "Covered latest" },
			],
			edges: [
				{ from: "x", to: "y" },
				{ from: "y", to: "z" },
			],
			version: 1,
		};
		const msgs: PopupMessage[] = [
			{ parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "y" }, output: { correct: true } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "z" }, output: { correct: true } }] },
		];
		const html = renderToStaticMarkup(<PlanPopup messages={msgs} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-x" data-status="upcoming"/);
		assert.match(html, /data-testid="plan-node-y" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-z" data-status="current"/);
		// Exactly one gray edge (x→y, gray origin) and one white edge (y→z,
		// both ends white): count the head markers, one per edge.
		const dimHeads = (html.match(/marker-end="url\(#.*-dim\)"/g) ?? []).length;
		const whiteHeads = (html.match(/marker-end="url\(#(?:R\d+|[a-z0-9-]+)\)"/g) ?? []).length;
		assert.equal(dimHeads, 1, "the gray-origin edge dims");
		assert.equal(whiteHeads, 1, "the both-white edge stays white");
		assert.match(html, /<path[^>]*class="fill-none stroke-border"/);
		assert.match(html, /<path[^>]*class="fill-none stroke-line-strong"/);
	});

	it("renders the empty state when the session has no plan", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[{ parts: [] }]} onClose={() => {}} />);
		assert.match(html, /No plan in this session yet\./);
	});
});