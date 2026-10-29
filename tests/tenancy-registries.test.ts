import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

// Isolated multi-user data dir BEFORE any config-loading import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-registries-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_MULTI_USER = "1";
delete process.env.LH_LIBRARY_DIR;

const { runAsTenant, currentTenant } = await import("../src/core/tenant-context.ts");
const { tenantSingleton } = await import("../src/server/tenant-singleton.ts");
const { createExtractionPipeline, extractionStatuses, NotesImportError } = await import("../src/agent/subagents/extraction.ts");
const { setRequestSink, recordRequest } = await import("../src/agent/request-log.ts");
const { requestLogStore } = await import("../src/store/request-log.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { recoverStaleJobs } = await import("../src/server/jobs.ts");

const A = { id: "a", name: "A", isAdmin: false };
const B = { id: "b", name: "B", isAdmin: false };

test("tenantSingleton: one instance per tenant, make called once each, functions bound", () => {
	let made = 0;
	const s = tenantSingleton("__testSingleton", () => {
		made++;
		return { id: currentTenant()!.id, who() { return this.id; } };
	});
	assert.equal(runAsTenant(A, () => s.id), "a");
	assert.equal(runAsTenant(B, () => s.id), "b");
	assert.equal(runAsTenant(A, () => s.id), "a");
	assert.equal(made, 2);
	const who = runAsTenant(A, () => s.who);
	assert.equal(runAsTenant(B, () => who()), "a", "a detached method stays bound to its tenant's instance");
	assert.equal(runAsTenant(A, () => typeof s.who), "function");
});

test("a timer scheduled inside a tenant scope keeps the tenant", async () => {
	const seen = await new Promise<string | undefined>((resolve) => {
		runAsTenant(A, () => setTimeout(() => resolve(currentTenant()?.id), 0));
	});
	assert.equal(seen, "a");
});

test("extraction registries are per tenant", async () => {
	let enteredResolve!: () => void;
	const entered = new Promise<void>((r) => (enteredResolve = r));
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const faux = createFauxCore({});
	faux.setResponses([
		async () => {
			enteredResolve();
			await gate;
			return fauxAssistantMessage([fauxToolCall("submit_findings", { propositions: [], chains: [] }, { id: "c1" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("no"),
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const pipeline = createExtractionPipeline({ chatStore, graphStore, extractor: engine, auditor: engine });
	const input = { filePath: "x.md", text: "Some text to extract.", id: "src_same" };
	const run = runAsTenant(A, () => pipeline.importNotes(input));
	await entered;
	assert.equal(runAsTenant(A, () => extractionStatuses().length), 1);
	assert.equal(runAsTenant(B, () => extractionStatuses().length), 0);
	// While A is in flight, B starting the same source id must not be refused as busy.
	let bBusy = false;
	await runAsTenant(B, () => pipeline.importNotes(input)).catch((e: unknown) => {
		bBusy = e instanceof NotesImportError && e.outcome === "busy";
	});
	assert.equal(bBusy, false);
	release();
	await run.catch(() => undefined);
	assert.equal(runAsTenant(A, () => extractionStatuses().length), 0);
});

test("recordRequest writes under the tenant; NoTenantError is always logged", () => {
	setRequestSink((l) => requestLogStore.append(l));
	const line = {
		v: 1 as const, at: "2026-10-29T10:00:00.000Z", purpose: "x", category: "other", provider: "p", model: "m", outcome: "ok" as const,
	};
	runAsTenant(A, () => recordRequest(line as never));
	assert.ok(fs.existsSync(path.join(dir, "users", "a", "logs")));
	const orig = console.error;
	let errors = 0;
	console.error = () => void errors++;
	try {
		recordRequest(line as never);
		recordRequest(line as never);
	} finally {
		console.error = orig;
		setRequestSink(null);
	}
	assert.equal(errors, 2);
});

test("recoverStaleJobs throttles per tenant", () => {
	let sweeps = 0;
	const orig = chatStore.listChats;
	chatStore.listChats = () => (sweeps++, []);
	try {
		runAsTenant(A, () => recoverStaleJobs());
		runAsTenant(A, () => recoverStaleJobs());
		assert.equal(sweeps, 1);
		runAsTenant(B, () => recoverStaleJobs());
		assert.equal(sweeps, 2);
	} finally {
		chatStore.listChats = orig;
	}
});
