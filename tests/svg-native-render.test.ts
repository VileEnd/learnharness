/** Static native SVG rendering, bounded render-only repairs, and native
 * failures that never dispatch a browser or system Chrome. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import puppeteer from "puppeteer-core";
import { Resvg } from "@resvg/resvg-js";
import * as photon from "@silvia-odwyer/photon-node";
import { isAcceptableReference, realHeadless } from "../src/agent/subagents/headless.ts";

function pngFacts(buf: Buffer): { w: number; h: number; idats: number } {
	assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	let off = 8;
	let idats = 0;
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString("ascii");
		if (type === "IDAT") idats++;
		off += 12 + len;
	}
	return { w, h, idats };
}

function forbidBrowser(t: TestContext) {
	const unexpected = () => { assert.fail("SVG rendering must not dispatch a browser or Chrome"); };
	const spawn = t.mock.method(childProcess, "spawn", unexpected);
	const connect = t.mock.method(puppeteer, "connect", unexpected);
	const launch = t.mock.method(puppeteer, "launch", unexpected);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		assert.equal(spawn.mock.callCount(), 0);
		assert.equal(connect.mock.callCount(), 0);
		assert.equal(launch.mock.callCount(), 0);
	});
}

const RED = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>';

describe("native renderSvg (resvg only)", () => {
	it("repairs an ordinary missing namespace and returns actual opaque red pixels", async (t) => {
		forbidBrowser(t);
		const original = RED.replace(' xmlns="http://www.w3.org/2000/svg"', "");
		const png = await realHeadless.renderSvg(original);
		assert.deepEqual(pngFacts(png), { w: 80, h: 40, idats: 1 });
		const image = photon.PhotonImage.new_from_byteslice(png);
		try {
			const pixels = image.get_raw_pixels();
			assert.equal(pixels.length, 80 * 40 * 4);
			for (let i = 0; i < pixels.length; i++) assert.equal(pixels[i], [255, 0, 0, 255][i % 4]);
		} finally { image.free(); }
		assert.equal(original.includes("xmlns"), false, "rendering does not rewrite the original source");
	});

	it("repairs ordinary HTML nbsp exactly like a numeric entity, including attribute values", async (t) => {
		forbidBrowser(t);
		const svg = RED.replace("</svg>", '<text x="2" y="20" aria-label="A&nbsp;B">A&nbsp;B</text></svg>');
		assert.deepEqual(await realHeadless.renderSvg(svg), await realHeadless.renderSvg(svg.replaceAll("&nbsp;", "&#160;")));
	});

	it("does not broaden the repairs or dispatch a browser for malformed SVG", async (t) => {
		forbidBrowser(t);
		await assert.rejects(realHeadless.renderSvg(RED.replace('xmlns="http://www.w3.org/2000/svg"', 'xmlns=""')), /root node/);
		await assert.rejects(realHeadless.renderSvg("<svg><unclosed>"), /never closed/);
	});

	it("propagates a native renderer failure without browser/Chrome recovery", async (t) => {
		forbidBrowser(t);
		const error = new Error("owned native renderer failure");
		t.mock.method(Resvg.prototype, "render", () => { throw error; });
		await assert.rejects(realHeadless.renderSvg(RED), (value) => value === error);
	});

	it("renders an attribute-sized SVG at its intrinsic size", async () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#3355aa"/></svg>';
		const png = await realHeadless.renderSvg(svg);
		const f = pngFacts(png);
		assert.equal(f.w, 240);
		assert.equal(f.h, 160);
		assert.equal(f.idats, 1, "single-IDAT canonical PNG");
	});

	it("viewBox-only SVG gets the 900px-wide default", async () => {
		// No width attr anywhere (svgViewport grabs the FIRST width= in the
		// document — children included — a pre-existing quirk kept for
		// parity; use a circle so the default branch is exercised).
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><circle cx="150" cy="100" r="90" fill="#aa5533"/></svg>';
		const png = await realHeadless.renderSvg(svg);
		const f = pngFacts(png);
		assert.equal(f.w, 900, "svgViewport default width");
		assert.equal(f.h, 600, "aspect preserved from viewBox");
	});

	it("width/height opts override for viewBox-only SVGs", async () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="#33aa55"/></svg>';
		const png = await realHeadless.renderSvg(svg, { width: 500, height: 125 });
		const f = pngFacts(png);
		assert.equal(f.w, 500);
	});

	it("text-bearing SVG renders with system fonts (non-trivial output)", async () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">
  <rect width="300" height="100" fill="#ffffff"/>
  <text x="150" y="60" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#111111">Harness</text>
</svg>`;
		const png = await realHeadless.renderSvg(svg);
		const f = pngFacts(png);
		assert.equal(f.w, 300);
		// A blank 300x100 white PNG is ~300 bytes; glyphs push it well past.
		assert.ok(png.length > 1000, `text rendered (png ${png.length} bytes > 1000)`);
	});
});

// resvg loads any local file an <image>/<feImage> names, and the render goes
// back to the model as its figure, so only inline data:image/ sources may draw.
describe("native renderSvg: no local files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-svg-files-"));
	const SIZE = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8">';
	const redPng = async () => realHeadless.renderSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#f00"/></svg>`);
	const redPixels = (png: Buffer) => {
		const image = photon.PhotonImage.new_from_byteslice(png);
		try {
			const px = image.get_raw_pixels();
			let n = 0;
			for (let i = 0; i < px.length; i += 4) if (px[i]! > 200 && px[i + 1]! < 50) n++;
			return n;
		} finally { image.free(); }
	};
	const drawn = async (body: string) => redPixels(await realHeadless.renderSvg(`${SIZE}${body}</svg>`));

	it("draws an inline data:image/png and nothing from a local file", async (t) => {
		const png = await redPng();
		const file = path.join(dir, "red.png");
		fs.writeFileSync(file, png);
		const rel = path.relative(process.cwd(), file);
		const data = `data:image/png;base64,${png.toString("base64")}`;
		const img = (href: string, attr = "href") => `<image ${attr}="${href}" width="8" height="8"/>`;
		assert.equal(await drawn(img(data)), 64, "an inline data:image is still drawn");
		assert.equal(await drawn(img(data, "xlink:href")), 64);
		for (const [name, body] of Object.entries({
			absolute: img(file),
			"absolute xlink": img(file, "xlink:href"),
			relative: img(rel),
			"file url": img(`file://${file}`),
			"entity-encoded path": img(file.replace("/", "&#47;")),
			"other namespace prefix": `<s:image xmlns:s="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink" q:href="${file}" width="8" height="8"/>`,
			"in a pattern": `<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse">${img(file)}</pattern><rect width="8" height="8" fill="url(#p)"/>`,
			"nested inline svg": `<svg width="8" height="8">${img(file)}</svg>`,
			feImage: `<filter id="f"><feImage href="${file}"/></filter><rect width="8" height="8" filter="url(#f)"/>`,
			"entity declared in a doctype": `<!DOCTYPE svg [<!ENTITY p "${file}">]>${img("&p;")}`,
			"markup hidden in an entity": `<!DOCTYPE svg [<!ENTITY e "<image href='${file}' width='8' height='8'/>">]>&e;`,
		})) {
			const svg = body.startsWith("<!DOCTYPE") ? `${body.slice(0, body.indexOf("]>") + 2)}${SIZE}${body.slice(body.indexOf("]>") + 2)}</svg>` : `${SIZE}${body}</svg>`;
			// Not drawn, or refused outright (entity declarations are refused).
			const result = await realHeadless.renderSvg(svg).then(redPixels, () => 0);
			assert.equal(result, 0, `${name}: a local file must not be drawn`);
		}
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	});
});

// The reference guard must hold for the exact text resvg parses, so these
// cases attack the rewrite itself: parser/tokenizer disagreements over
// DOCTYPE literals and attribute removal that glues the neighbours together.
describe("native renderSvg: reference guard holds for the parsed text", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-svg-guard-"));
	const file = path.join(dir, "red.png");
	const ROOT = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16">';
	const IMAGE = `<image href="${file}" width="16" height="16"/>`;
	const doc = (before: string, body: string) => `${before}${ROOT}${body}</svg>`;
	let dataUri = "";

	/** Red pixels drawn, or -1 when the render fails (an acceptable outcome). */
	async function red(svg: string): Promise<number> {
		let png: Buffer;
		try { png = await realHeadless.renderSvg(svg); } catch { return -1; }
		const image = photon.PhotonImage.new_from_byteslice(png);
		try {
			const px = image.get_raw_pixels();
			let n = 0;
			for (let i = 0; i < px.length; i += 4) if (px[i]! > 200 && px[i + 1]! < 50) n++;
			return n;
		} finally { image.free(); }
	}

	before(async () => {
		const png = await realHeadless.renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#f00"/></svg>');
		fs.writeFileSync(file, png);
		dataUri = `data:image/png;base64,${png.toString("base64")}`;
		assert.equal(await red(doc("", `<image href="${dataUri}" width="16" height="16"/>`)), 256, "the picture draws when named by an inline source");
		const saved = photon.PhotonImage.new_from_byteslice(fs.readFileSync(file));
		try { assert.equal(saved.get_width(), 16, "the temp file exists"); } finally { saved.free(); }
	});

	it("DOCTYPE literals that look like comment, CDATA or PI openers do not hide the image", async () => {
		const cases: Array<[string, string]> = [
			['<!DOCTYPE svg [<!ENTITY e "<!--">]>', "<!-- x -->"],
			["<!DOCTYPE svg [<!ENTITY e '<!--'>]>", "<!-- x -->"],
			['<!DOCTYPE svg [<!ENTITY e "<![CDATA[">]>', "<![CDATA[y]]>"],
			['<!DOCTYPE svg [<!ENTITY e "<?">]>', "<?x y?>"],
			['<!DOCTYPE svg [<!ENTITY e "a<!--b">]>', "<!---->"],
			['<!DOCTYPE svg [<!ATTLIST g a CDATA "<!--">]>', "<!-- x -->"],
			['<!DOCTYPE svg SYSTEM "<!--">', "<!-- x -->"],
			['<!DOCTYPE svg PUBLIC "<!--" "x">', "<!-- x -->"],
		];
		for (const [before, after] of cases) assert.ok((await red(doc(before, IMAGE + after))) <= 0, `${before}`);
	});

	it("removing an attribute cannot glue its neighbours into a reference", async () => {
		for (const body of [
			`<image hre href="x"f="${file}" width="16" height="16"/>`,
			`<image hre xlink:href="x"f="${file}" width="16" height="16"/>`,
		]) assert.ok((await red(doc("", body))) <= 0, body);
	});

	it("an href spelled anywhere in the text, even where it is not an attribute, is not trusted", async () => {
		for (const body of [`<!-- <image href="${file}"/> -->${IMAGE}`, `<![CDATA[ href="${file}" ]]>${IMAGE}`, `<image data-href="${file}" href="${file}" width="16" height="16"/>`]) {
			assert.ok((await red(doc("", body))) <= 0, body);
		}
	});

	it("a plain public DOCTYPE with an xml prolog still renders", async () => {
		const before = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n';
		assert.equal(await red(doc(before, '<rect width="16" height="16" fill="#f00"/>')), 256);
	});

	it("figures that merely show or select on href still render", async () => {
		assert.ok(await red(doc("", '<rect width="16" height="16" fill="#f00"/><text x="1" y="8">&lt;a href="page.html"&gt;</text>')) > 0, "renders, text drawn over the red");
		assert.equal(await red(doc("", '<style>a[href="x"] { fill: blue } a[href$=".pdf"] { fill: blue }</style><rect width="16" height="16" fill="#f00"/>')), 256);
	});

	it("same-document references and inline images still draw", async () => {
		assert.equal(await red(doc("", '<defs><rect id="r" width="16" height="16" fill="#f00"/></defs><use href="#r"/>')), 256);
		assert.equal(await red(doc("", '<defs><linearGradient id="h"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#f00"/></linearGradient><linearGradient id="g" xlink:href="#h"/></defs><rect width="16" height="16" fill="url(#g)"/>')), 256);
		assert.equal(await red(doc("", `<pattern id="p" width="16" height="16" patternUnits="userSpaceOnUse"><image href="${dataUri}" width="16" height="16"/></pattern><rect width="16" height="16" fill="url(#p)"/>`)), 256);
		assert.equal(await red(doc("", `<image xlink:href='${dataUri}' width="16" height="16"/>`)), 256);
	});

	it("a data: value that is not a well-formed inline image address draws nothing", async () => {
		const rel = path.relative(process.cwd(), file);
		for (const value of [`data:image/../../../../${file}`, `data:image/${rel}`, `data:text/plain,${file}`, `data:image/png${file}`]) {
			assert.ok((await red(doc("", `<image href="${value}" width="16" height="16"/>`))) <= 0, value);
		}
	});

	it("a percent-encoded inner SVG in a data: address cannot load the file either", async () => {
		const inner = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><image href="${file}" width="16" height="16"/></svg>`);
		assert.ok((await red(doc("", `<image href="data:image/svg+xml,${inner}" width="16" height="16"/>`))) <= 0);
	});

	it("a real attribute that merely ends in href renders instead of breaking the figure", async () => {
		for (const attr of ['data-href="x"', "x-href='y'", 'xlink:HREF="z"', 'data-href = "x"']) {
			assert.equal(await red(doc("", `<rect width="16" height="16" fill="#f00" ${attr}/>`)), 256, attr);
		}
	});

	it("when the parser rejects text the guard rewrote, the error is in the model's terms", async () => {
		const svg = doc("", `<image/href="${file}" width="16" height="16"/>`);
		await assert.rejects(realHeadless.renderSvg(svg), (error: Error) => /an href may only point to #id or an inline data:image\/ address; remove the other reference/.test(error.message) && /\(.+\)$/.test(error.message));
		// A parse error the guard had no part in keeps its own message.
		await assert.rejects(realHeadless.renderSvg("<svg><unclosed>"), (error: Error) => !/href/.test(error.message));
	});

	it("only a path-free fragment and an inline image with its comma are accepted references", () => {
		for (const ok of ["#id", "", " #a ", "data:image/png;base64,AAAA", "data:image/svg+xml,%3Csvg%3E", "data:image/jpeg,x", "DATA:image/PNG;charset=x;base64,AA"]) assert.equal(isAcceptableReference(ok), true, ok);
		for (const bad of ["#/../x.png", "#a/b", "#a\\b", "data:image/png;/x.png", "data:image/png", "data:image/png;base64", "data:image/../x.png", "data:text/plain,x", "/abs/x.png", "x.png", "file:///x.png"]) assert.equal(isAcceptableReference(bad), false, bad);
	});

	it("seeded fuzz: no combination of fragments draws the file", async (t) => {
		const seed = Number(process.env.LH_FUZZ_SEED ?? 20261112);
		let state = seed >>> 0;
		const rnd = () => { state = (state + 0x6d2b79f5) >>> 0; let x = Math.imul(state ^ (state >>> 15), 1 | state); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
		const pick = <T,>(items: readonly T[]) => items[Math.floor(rnd() * items.length)]!;
		const SVGNS = "http://www.w3.org/2000/svg";
		const XLINK = "http://www.w3.org/1999/xlink";
		const images = [
			IMAGE,
			IMAGE,
			`<image xlink:href='${file}' width="16" height="16"/>`,
			`<image href = "${file}" width="16" height="16"></image>`,
			`<image data-x=">" href="${file}" width="16" height="16"/>`,
			`<image href="x" href="${file}" width="16" height="16"/>`,
			`<s:image xmlns:s="${SVGNS}" href="${file}" width="16" height="16"/>`,
			`<image xmlns:q="${XLINK}" q:href="${file}" width="16" height="16"/>`,
			`<g><image href="${file}" width="16" height="16"/></g>`,
			`<a href="x"><image href='${file}' width="16" height="16"/></a>`,
			`<filter id="f"><feImage href="${file}"/></filter><rect width="16" height="16" filter="url(#f)"/>`,
			`<image hre href="x"f="${file}" width="16" height="16"/>`,
			`<image hre xlink:href="x"f="${file}" width="16" height="16"/>`,
			`<image/href="${file}" width="16" height="16"/>`,
		];
		const frags = ["<!--", "-->", "<![CDATA[", "]]>", "<?x", "?>", '"', "'", " ", "\n", "hre", "f=", 'href="x"', "xlink:", "<!---->", "<g>", "</g>", ">", "<", "&e;", "&#47;", "<!ENTITY e \"x\">", '<text x="1" y="8">', "</text>"];
		// Balanced pieces keep most inputs well-formed, so most really render.
		const balanced = ["<!-- c -->", "<![CDATA[y]]>", "<?x y?>", "<g/>", " ", "\n", "<!-- href=\"x\" -->", '<g data-href="x"/>', '<g xlink:HREF="y"/>', '<a xlink:href="#z"/>',
			'<text x="1" y="8">&lt;a href=&quot;p&quot;&gt;</text>', '<rect width="1" height="1" x-href="q"/>', "<![CDATA[ href=\"x\" ]]>", "<!--\n-->"];
		const befores = [
			"", "", "", '<?xml version="1.0"?>\n', '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "a" "b">\n', "<!DOCTYPE svg>", '<!DOCTYPE svg PUBLIC "a" "b">',
			'<!DOCTYPE svg [<!ENTITY e "<!--">]>', "<!DOCTYPE svg [<!ENTITY e '<!--'>]>", '<!DOCTYPE svg [<!ENTITY e "<![CDATA[">]>',
			'<!DOCTYPE svg [<!ENTITY e "<?">]>', '<!DOCTYPE svg [<!ENTITY e "a<!--b">]>', '<!DOCTYPE svg [<!ATTLIST g a CDATA "<!--">]>',
			'<!DOCTYPE svg SYSTEM "<!--">', '<!DOCTYPE svg PUBLIC "<!--" "x">', '<!DOCTYPE svg [<!ENTITY e "x">]>',
			`<!DOCTYPE svg [<!ENTITY p "${file}">]>`,
		];
		const rawRed = (svg: string) => {
			try {
				const px = new Resvg(svg, { background: "#ffffff" }).render().pixels;
				let n = 0;
				for (let i = 0; i < px.length; i += 4) if (px[i]! > 200 && px[i + 1]! < 50) n++;
				return n;
			} catch { return -1; }
		};
		const started = Date.now();
		const N = 1500;
		let rendered = 0, leakedWithoutGuard = 0;
		for (let i = 0; i < N; i++) {
			const run = (n: number) => Array.from({ length: n }, () => pick(rnd() < 0.85 ? balanced : frags)).join("");
			const closer = rnd() < 0.5 ? pick(["<!-- x -->", "<![CDATA[y]]>", "<?x y?>", "<!---->"]) : "";
			const svg = doc(pick(befores), run(Math.floor(rnd() * 3)) + pick(images) + run(Math.floor(rnd() * 3)) + closer);
			// Unguarded control: the same input through raw resvg (no stripping, no guard).
			if (rawRed(svg) > 0) leakedWithoutGuard++;
			const drawn = await red(svg);
			if (drawn >= 0) rendered++;
			if (drawn > 0) assert.fail(`seed ${seed}, iteration ${i}: the file was drawn (${drawn} red pixels) for ${JSON.stringify(svg)}`);
		}
		assert.ok(rendered > N / 5, `the fuzz must mostly exercise renders that succeed, not only errors (${rendered}/${N}, seed ${seed})`);
		assert.ok(leakedWithoutGuard > N / 4, `the generator must keep producing inputs that leak when unguarded, or this test proves nothing (${leakedWithoutGuard}/${N}, seed ${seed})`);
		t.diagnostic(`${N} inputs in ${Date.now() - started} ms, ${rendered} rendered guarded, ${leakedWithoutGuard} draw the file unguarded, seed ${seed}`);
	});

	after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
});
