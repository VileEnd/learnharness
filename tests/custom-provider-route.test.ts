/**
 * POST /api/custom-provider: the connect policy around typed model ids and
 * a failed probe (upstream custom-provider-route), plus the probe parser and
 * the pure helpers (upstream custom-endpoint's server half).
 *   1. Typed ids make a FAILED probe survivable, but never a rejected key.
 *   2. A failed probe never shrinks the snapshot it already stored.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-route-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_MULTI_USER = "1";
delete process.env.LH_ADMIN_GROUP;
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

const h = await import("./helpers/custom-provider.ts");
const { discoverModels, mergeManualModels } = await import("../src/server/custom-provider.ts");
const { normalizeBaseUrl, parseModelIds } = await import("../src/core/contracts/custom-provider.ts");

const configFile = path.join(dir, "global", "custom-provider.json");
const stored = () => JSON.parse(fs.readFileSync(configFile, "utf8")) as { snapshot: { id: string }[]; models?: unknown; manualModels?: string[] };
const answerWith = (status: number, body?: unknown) => {
	globalThis.fetch = (async () => (body === undefined ? new Response("nope", { status }) : Response.json(body))) as typeof fetch;
};
const connected = () =>
	h.seed({
		snapshot: [{ id: "disc-1", context: 131072 }, { id: "disc-2" }, { id: "m1" }],
		models: { "disc-1": { context: 200000 }, "disc-2": { maxOutput: 8192 } },
		manualModels: ["m1"],
	});
const connect = (payload: Record<string, unknown>) => h.post({ baseUrl: h.BASE, mode: "key" in payload ? "key" : "keyless", pricing: "free", ...payload });

describe("POST /api/custom-provider — typed ids and a failed probe", () => {
	it("a transient failure keeps the stored models, their metadata and their pins", async () => {
		connected();
		answerWith(503);
		assert.equal((await connect({ manualModels: "m1" })).status, 200);
		const cp = stored();
		assert.deepEqual(cp.snapshot.map((m) => m.id), ["disc-1", "disc-2", "m1"]);
		assert.deepEqual(cp.snapshot[0], { id: "disc-1", context: 131072 }, "detected metadata survives");
		assert.deepEqual(cp.models, { "disc-1": { context: 200000 }, "disc-2": { maxOutput: 8192 } }, "no prune on a failed probe");
		assert.deepEqual(cp.manualModels, ["m1"]);
	});

	it("a rejected key fails the connect even when ids are typed", async () => {
		connected();
		answerWith(401);
		const before = stored();
		assert.equal((await connect({ key: "sk-abcdefghijk", manualModels: "m1" })).status, 502);
		assert.deepEqual(stored(), before, "nothing is stored on an auth failure");
	});

	it("a new endpoint with no model list starts from the typed ids alone", async () => {
		connected();
		answerWith(404);
		assert.equal((await connect({ baseUrl: "http://192.0.2.40/v1", manualModels: "y, x" })).status, 200);
		const cp = stored();
		assert.deepEqual(cp.snapshot.map((m) => m.id), ["x", "y"], "the previous endpoint's models do not follow the URL");
		assert.equal(cp.models, undefined, "no pin or rate survives a URL change");
		assert.deepEqual(cp.manualModels, ["y", "x"], "the typed order is kept");
	});

	it("no model list and no typed ids still refuses, with the hint", async () => {
		answerWith(404);
		const res = await connect({});
		assert.equal(res.status, 502);
		const body = (await res.json()) as { error: string; detail: string };
		assert.equal(body.error, "probe_failed");
		assert.match(body.detail, /404/);
		assert.match(body.detail, /add model IDs manually/);
	});

	it("a working probe merges the typed ids, keeps discovered metadata and prunes pins to the offered ids", async () => {
		connected();
		answerWith(200, { data: [{ id: "disc-1", context_length: 65536 }] });
		const res = await connect({ manualModels: "disc-1, m2", pricing: "paid" });
		assert.equal(res.status, 200);
		const status = (await res.json()) as { config: { pricing: string; snapshot: { id: string }[] } };
		assert.equal(status.config.pricing, "paid");
		const cp = stored();
		assert.deepEqual(cp.snapshot.map((m) => m.id), ["disc-1", "m2"]);
		assert.deepEqual(cp.snapshot[0], { id: "disc-1", context: 65536 }, "discovery is not replaced by a typed id");
		assert.deepEqual(cp.models, { "disc-1": { context: 200000 } });
		assert.deepEqual(cp.manualModels, ["disc-1", "m2"]);
	});
});

describe("discoverModels", () => {
	const reply = (body: unknown) => {
		globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
	};
	it("reads OpenAI {data:[{id}]}, Ollama {models:[…]} and bare arrays", async () => {
		reply({ data: [{ id: "b" }, { id: "a" }] });
		assert.deepEqual(await discoverModels(h.BASE), { ok: true, models: [{ id: "a" }, { id: "b" }] });
		reply({ models: [{ id: "qwen3:8b" }] });
		assert.deepEqual(await discoverModels(h.BASE), { ok: true, models: [{ id: "qwen3:8b" }] });
		reply(["s"]);
		assert.deepEqual(await discoverModels(h.BASE), { ok: true, models: [{ id: "s" }] });
	});
	it("detects image input, reasoning and token limits from metadata only", async () => {
		reply({
			data: [
				{ id: "v", architecture: { input_modalities: ["text", "image"] }, max_input_tokens: 32000, max_output_tokens: 1000 },
				{ id: "r", supported_parameters: ["reasoning"], context_length: 4096 },
				{ id: "deepseek-reasoner-by-name" },
			],
		});
		const found = await discoverModels(h.BASE);
		assert.ok(found.ok);
		assert.deepEqual(found.models, [
			{ id: "deepseek-reasoner-by-name" },
			{ id: "r", reasoning: true, context: 4096 },
			{ id: "v", image: true, context: 32000, maxOutput: 1000 },
		]);
	});
	it("reports a non-2xx and an unrecognized shape as honest errors; guards the scheme before any fetch", async () => {
		answerWith(500);
		assert.deepEqual(await discoverModels(h.BASE), { ok: false, error: "Endpoint returned HTTP 500", status: 500 });
		reply({ nope: true });
		assert.deepEqual(await discoverModels(h.BASE), { ok: false, error: "Endpoint response was not a model list" });
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return Response.json([]);
		}) as typeof fetch;
		assert.equal((await discoverModels("ftp://h.example.com")).ok, false);
		assert.equal(called, false);
	});
});

describe("pure helpers", () => {
	it("normalizeBaseUrl keeps the path, drops trailing slashes, rejects junk", () => {
		assert.equal(normalizeBaseUrl(" http://192.0.2.10:11434/v1/ "), "http://192.0.2.10:11434/v1");
		for (const bad of ["", "not a url", "ftp://h.example.com", "http://u:p@h.example.com"]) assert.equal(normalizeBaseUrl(bad), "");
	});
	it("parseModelIds splits on commas and whitespace, trims and dedupes", () => {
		assert.deepEqual(parseModelIds(" a, b  a\nqwen3:8b "), ["a", "b", "qwen3:8b"]);
		assert.deepEqual(parseModelIds(["x", 1, " ", "x"]), ["x"]);
	});
	it("mergeManualModels adds typed ids and never replaces discovered metadata", () => {
		assert.deepEqual(mergeManualModels([{ id: "b", context: 9 }], ["b", "a"]), [{ id: "a" }, { id: "b", context: 9 }]);
	});
});
