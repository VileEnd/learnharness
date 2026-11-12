/**
 * Normalisation, the content hash and the MinHash sketch work block by block
 * and word by word so a large text never exists several times over in memory.
 * What they produce must stay exactly what the whole-text versions produced:
 * the document id is the hash, and the sketch is stored in every document's meta.
 * The reference functions below are the original whole-text implementations.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { contentHash, fingerprint, MINHASH_SIZE, minhash, normalizedPieces, normalizeText } from "../src/core/documents.ts";

// ─── the original implementations ────────────────────────────────────────────

const refNormalize = (text: string, keepCase = false): string => {
	const open = /^---[ \t]*\r?\n/.exec(text);
	let body = text;
	if (open) {
		const rest = text.slice(open[0].length);
		const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
		if (close) body = text.slice(open[0].length + close.index + close[0].length);
	}
	const out = body.replace(/<!--\s*page\s+(\d+)\s*-->/gi, " ").replace(/\s+/g, " ").trim();
	return keepCase ? out : out.toLowerCase();
};

const fnv1a = (s: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return h >>> 0;
};
const mix = (h: number): number => {
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
};
const SEEDS = Array.from({ length: MINHASH_SIZE }, (_, i) => mix(Math.imul(i + 1, 0x9e3779b1)));
const refMinhash = (normalized: string): number[] => {
	const words = normalized.split(" ").filter((w) => w !== "");
	const shingles = new Set<string>();
	if (words.length > 0 && words.length <= 5) shingles.add(words.join(" "));
	for (let i = 0; i + 5 <= words.length; i++) shingles.add(words.slice(i, i + 5).join(" "));
	const sig = new Array<number>(MINHASH_SIZE).fill(0xffffffff);
	for (const shingle of shingles) {
		const base = fnv1a(shingle);
		for (let i = 0; i < MINHASH_SIZE; i++) sig[i] = Math.min(sig[i]!, mix((base ^ SEEDS[i]!) >>> 0));
	}
	return sig;
};

// ─── inputs that stress the block cuts ───────────────────────────────────────

const PARTS = ["alpha", "Beta", "ΟΔΥΣΣΕΥΣ", "Σ", "İstanbul", "ß", "\u{1F600}", " ", "  ", "\n", "\r\n", "\t", " ", " ", "﻿",
	"<!-- page 3 -->", "<!--  page\n4\n-->", "<!--", "-->", "<!-- page", "page", "12", "<!-- note -->", "---\n", "# H\n"];

/** Deterministic pseudo-random token soup. */
function soup(seed: number, tokens: number): string {
	let s = seed;
	const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
	return Array.from({ length: tokens }, () => PARTS[Math.floor(next() * PARTS.length)]).join(next() < 0.5 ? "" : " ");
}

const FIXED = [
	"", " ", "\n\n", "a", "a b c", "a b c d e", "a b c d e f", "<!-- page 1 -->", " <!-- page 1 --> ", "x<!-- page 1 -->y", "x <!-- page 1 --> y",
	"---\ntitle: t\n---\n\n<!-- page 1 -->\nHello   World\n\n<!-- page 2 -->\nsecond\tline\n", "---\nno close", "ΟΔΥΣΣΕΥΣ ΣΟΦΟΣ", "a<!-- page 1 --><!-- page 2 -->b",
];

describe("block-wise normalisation equals whole-text normalisation", () => {
	for (const block of [1, 2, 3, 5, 8, 13, 64, 1 << 20]) {
		it(`block of ${block} characters: fixed and random texts`, () => {
			const texts = [...FIXED, ...Array.from({ length: 150 }, (_, i) => soup(i + 1, 5 + (i % 40)))];
			for (const text of texts) {
				for (const keepCase of [false, true]) {
					const pieces = [...normalizedPieces(text, { keepCase, block })];
					assert.equal(pieces.join(""), refNormalize(text, keepCase), JSON.stringify(text));
					// A piece never starts or ends inside a word: after the first, each starts with the separating space.
					for (const piece of pieces.slice(1)) assert.ok(piece.startsWith(" ") || refNormalize(text, keepCase) === "", JSON.stringify(piece));
				}
			}
		});
	}

	it("normalizeText, contentHash, minhash and fingerprint match the originals", () => {
		for (const text of [...FIXED, ...Array.from({ length: 60 }, (_, i) => soup(1000 + i, 30 + i * 3))]) {
			const want = refNormalize(text);
			assert.equal(normalizeText(text), want);
			assert.equal(normalizeText(text, { keepCase: true }), refNormalize(text, true));
			assert.equal(contentHash(text), createHash("sha256").update(want).digest("hex"));
			assert.deepEqual(minhash(want), refMinhash(want));
			const fp = fingerprint(text);
			assert.equal(fp.contentHash, createHash("sha256").update(want).digest("hex"));
			assert.deepEqual(fp.minhash, refMinhash(want));
		}
	});

	it("a text spanning several default-size blocks, markers at the cuts, matches the original", () => {
		const para = `${"word ".repeat(1000)}\n\n`;
		const text = `---\nt: 1\n---\n${(para + "<!--\n  page   7 -->\n").repeat(450)}`;
		assert.ok(text.length > 2 * (1 << 20));
		const want = refNormalize(text);
		assert.equal(normalizeText(text), want);
		assert.deepEqual(fingerprint(text).minhash, refMinhash(want));
	});
});
