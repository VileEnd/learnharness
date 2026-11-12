/**
 * Second layer behind the markdown image block: the app's pages carry a
 * Content-Security-Policy with only img-src, so no image can load from another
 * origin whatever renders it. Every image the app shows itself is same-origin,
 * a data: URL or a blob: URL. (A srcdoc demo iframe inherits this policy.)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nextConfig from "../next.config.ts";

describe("image policy header", () => {
	it("every route gets one Content-Security-Policy with only img-src 'self' data: blob:", async () => {
		const rules = await nextConfig.headers?.();
		assert.ok(rules && rules.length > 0, "next.config.ts has no headers()");
		const csp = rules.flatMap((r) => r.headers.filter((h) => h.key.toLowerCase() === "content-security-policy"));
		assert.equal(csp.length, 1);
		assert.equal(csp[0]?.value, "img-src 'self' data: blob:");
		assert.equal(rules.find((r) => r.headers.some((h) => h.key.toLowerCase() === "content-security-policy"))?.source, "/:path*");
	});
});
