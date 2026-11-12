/**
 * The cap check runs on every LLM call, and each call appends a request-log
 * line, so the month's spend must be folded incrementally: a call after one
 * appended line parses that line, not the whole month again, and the total
 * stays identical to a full fold. Isolated LH_DATA_DIR (dynamic imports).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import type { RequestLogLine } from "../src/core/contracts/usage.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-spend-inc-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { stores } = await import("../src/server/stores.ts");
const { spentThisMonth } = await import("../src/server/model-gate.ts");
const { monthSpend } = await import("../src/server/usage.ts");

const line = (i: number, cost?: number): RequestLogLine => ({
	v: 1,
	at: new Date().toISOString(),
	purpose: "teacher",
	category: "teaching",
	provider: "p",
	model: "m",
	outcome: "ok",
	chatId: `chat_${i % 5}`,
	...(cost === undefined ? {} : { providerCostUsd: cost }),
});

it("an appended line is folded alone and the total equals a full fold", () => {
	for (let i = 0; i < 200; i++) stores.requestLog.append(line(i, 0.001 * (i % 7 + 1)));
	stores.requestLog.append(line(200)); // no cost and no usage: counts as unpriced

	// Count every request-log line the store hands out from here on.
	let handedOut = 0;
	const log = stores.requestLog as unknown as Record<string, (...a: unknown[]) => unknown>;
	for (const name of Object.keys(log).filter((n) => n.startsWith("read"))) {
		const real = log[name]!.bind(log);
		log[name] = (...a) => {
			const out = real(...a) as unknown[] | { lines: unknown[] };
			handedOut += Array.isArray(out) ? out.length : out.lines.length;
			return out;
		};
	}

	const first = spentThisMonth();
	assert.deepEqual(first, monthSpend());
	assert.equal(first.unpriced, 1);

	stores.requestLog.append(line(201, 0.0123));
	handedOut = 0;
	const second = spentThisMonth();
	assert.equal(handedOut, 1, "only the appended line is read");
	assert.deepEqual(second, monthSpend(), "the total is exactly the full fold's");
	assert.ok(second.usd > first.usd);

	handedOut = 0;
	assert.deepEqual(spentThisMonth(), second);
	assert.equal(handedOut, 0, "an unchanged log reads nothing");
});

it("folding a month in pieces equals folding it whole", async () => {
	const { foldSpend, summarizeMonth } = await import("../src/core/usage.ts");
	const month = new Date().toISOString().slice(0, 7);
	const mixed: RequestLogLine[] = [
		line(0, 0.1),
		line(1),
		{ ...line(2), outcome: "error" }, // an error with no usage is not billable
		{ ...line(3), outcome: "error", input: 10 },
		{ ...line(4), category: "search", purpose: "search" },
		{ ...line(5), purpose: "dictation", category: "library" },
		line(6, 0.2),
		{ ...line(7, 0.3), at: "2001-01-01T00:00:00.000Z" }, // another month
		line(8, 0.7),
	];
	const price = () => null;
	const whole = summarizeMonth(month, mixed, price);
	for (let cut = 0; cut <= mixed.length; cut++) {
		const head = foldSpend({ usd: 0, unpriced: 0 }, month, mixed.slice(0, cut), price);
		const both = foldSpend(head, month, mixed.slice(cut), price);
		assert.deepEqual(both, { usd: whole.totalUsd ?? 0, unpriced: whole.unpricedCalls }, `cut at ${cut}`);
	}
});
